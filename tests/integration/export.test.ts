import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { findExportBrowser } from '../../src/fs/export-file.js';
import { handleNotebookExport } from '../../src/mcp/tools/export.js';
import { renderWithBrowser } from '../../src/render/browser.js';
import { exportContext } from '../fixtures/export.js';

let browser: string | undefined;
try {
  browser = findExportBrowser();
} catch (cause) {
  process.stderr.write(`export browser tests unavailable: ${cause instanceof Error ? cause.message : String(cause)}\n`);
}

it.skipIf(browser === undefined).each(['pdf', 'png'] as const)('[EXPORT][U1][U11] exports saved content to a real browser %s and cleans its profile', async (format) => {
  const f = await exportContext();
  try {
    const outcome = await handleNotebookExport(f.ctx, { path: f.notebookPath, format });
    if (!('payload' in outcome)) {
      throw new Error(`${outcome.error.code}: ${outcome.error.message}; ${JSON.stringify(outcome.error.detail)}`);
    }
    const output = await readFile(path.join(f.workspace, `报告.${format}`));
    if (format === 'pdf') {
      expect(output.subarray(0, 5).toString()).toBe('%PDF-');
      expect(output.toString('latin1')).toContain('/Type /Page');
      expect(output.subarray(-30).toString()).toContain('%%EOF');
    } else {
      expect(output.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(output.readUInt32BE(16)).toBe(1200);
      expect(output.readUInt32BE(20)).toBeGreaterThan(500);
    }
    expect(await readFile(f.notebookPath, 'utf8')).toBe(f.source);
    expect((await readdir(f.workspace)).sort()).toEqual([`报告.${format}`, '报告.ipynb'].sort());
  } finally {
    await f.close();
  }
}, 90_000);

it.skipIf(browser === undefined)('[EXPORT] cancels an in-flight browser and leaves no live browser process or output', async () => {
  const f = await exportContext();
  const controller = new AbortController();
  let pid: number | undefined;
  try {
    const rendered = renderWithBrowser({
      executable: browser!, htmlPath: f.notebookPath, profilePath: path.join(f.workspace, 'profile'), format: 'png',
      signal: controller.signal, onWarning: () => undefined, onSpawn: (value) => { pid = value; controller.abort(); },
    });
    await expect(rendered).rejects.toMatchObject({ code: 'cancelled' });
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    await f.close();
  }
}, 30_000);

it.skipIf(browser === undefined)('[EXPORT] rejects an oversized PNG before taking a screenshot', async () => {
  const f = await exportContext();
  try {
    const htmlPath = path.join(f.workspace, 'tall.html');
    await writeFile(htmlPath, '<!doctype html><div style="height:33000px">Too tall</div>');
    await expect(renderWithBrowser({
      executable: browser!, htmlPath, profilePath: path.join(f.workspace, 'profile'), format: 'png', onWarning: () => undefined,
    })).rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('too large for one PNG') });
  } finally {
    await f.close();
  }
}, 30_000);

it.skipIf(browser === undefined)('[EXPORT] times out an in-flight browser and reclaims its process', async () => {
  const f = await exportContext();
  let pid: number | undefined;
  try {
    await expect(renderWithBrowser({
      executable: browser!, htmlPath: f.notebookPath, profilePath: path.join(f.workspace, 'profile'), format: 'pdf',
      timeoutMs: 1, onWarning: () => undefined, onSpawn: (value) => { pid = value; },
    })).rejects.toMatchObject({ code: 'exec_timeout' });
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    await f.close();
  }
}, 30_000);
