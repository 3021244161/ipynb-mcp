import { existsSync } from 'node:fs';
import { link, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

import { PathFence } from '../../src/fs/fence.js';
import { assertExportDestination, findExportBrowser, publishExportFile } from '../../src/fs/export-file.js';
import { handleNotebookExport } from '../../src/mcp/tools/export.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';
import { createServer } from '../../src/server.js';
import { exportContext, EXPORT_PNG } from '../fixtures/export.js';

it('[EXPORT][U1][U24][U26] exports HTML through the real SDK without kernel startup, source writes or base64 in tool text', async () => {
  const f = await exportContext();
  const server = createServer(f.ctx);
  const client = new Client({ name: 'export-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'notebook_export', arguments: { path: path.basename(f.notebookPath), format: 'html' } }) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text = result.content[0];
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') {
      throw new Error('missing text result');
    }
    expect(text.text).not.toContain(EXPORT_PNG);
    const payload = JSON.parse(text.text) as { output_path: string; bytes: number };
    const html = await readFile(payload.output_path, 'utf8');
    expect(html).toContain('分析报告');
    expect(payload.bytes).toBe(Buffer.byteLength(html));
    expect(payload.output_path).not.toContain('\\');
    expect(await readFile(f.notebookPath, 'utf8')).toBe(f.source);
    expect(existsSync(f.ctx.config.artifactDir)).toBe(false);
    expect(await readdir(f.workspace)).toEqual(expect.arrayContaining(['报告.ipynb', '报告.html']));
    expect((await readdir(f.workspace)).some((name) => name.startsWith('.ipynb-export-'))).toBe(false);
    const status = await client.callTool({ name: 'notebook_kernel', arguments: { action: 'status' } });
    expect(JSON.stringify(status)).toContain('kernels');
    expect(JSON.stringify(status)).not.toContain('kernel_id');
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

it('[EXPORT][U27] refuses overwrites by default and only replaces an explicitly allowed destination', async () => {
  const f = await exportContext();
  try {
    const output = path.join(f.workspace, 'report.html');
    await writeFile(output, 'original');
    const args = { path: f.notebookPath, format: 'html', output_path: output };
    expect(await handleNotebookExport(f.ctx, args)).toMatchObject({ error: { code: 'invalid_arguments' } });
    expect(await readFile(output, 'utf8')).toBe('original');
    expect(await handleNotebookExport(f.ctx, { ...args, overwrite: true, include_source: false })).toHaveProperty('payload');
    expect(await readFile(output, 'utf8')).not.toContain('MUST NOT EXECUTE');
    expect(await readFile(f.notebookPath, 'utf8')).toBe(f.source);
  } finally {
    await f.close();
  }
});

it.each([
  { format: 'jpg' }, { format: '' }, { format: undefined }, { output_path: '' },
  { output_path: 'report.pdf' }, { include_source: 'false' }, { overwrite: 1 }, { unknown: true },
  { output_path: 'missing/report.html' },
])('[EXPORT][U27] rejects invalid export arguments: %j', async (override) => {
  const f = await exportContext();
  try {
    const result = await handleNotebookExport(f.ctx, { path: f.notebookPath, format: 'html', ...override });
    expect(result).toMatchObject({ error: { code: 'invalid_arguments' } });
    expect(await readdir(f.workspace)).toEqual(['报告.ipynb']);
  } finally {
    await f.close();
  }
});

it('[EXPORT][U11] fences input, output and symlinked parents even when the server allows outside paths', async () => {
  const f = await exportContext();
  try {
    const inside = path.join(f.workspace, 'inside');
    const sibling = path.join(f.workspace, 'sibling');
    await mkdir(inside);
    await mkdir(sibling);
    await writeFile(path.join(inside, 'nb.ipynb'), f.source);
    await symlink(sibling, path.join(inside, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const ctx = { ...f.ctx, fence: new PathFence(inside, true, process.platform) };
    for (const args of [
      { path: f.notebookPath },
      { path: 'nb.ipynb', output_path: '../sibling/report.html' },
      { path: 'nb.ipynb', output_path: 'escape/report.html' },
    ]) {
      expect(await handleNotebookExport(ctx, { format: 'html', ...args })).toMatchObject({ error: { code: 'path_outside_root' } });
    }
    expect(await readdir(sibling)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('[EXPORT][U1][U11] refuses a hard link to the source and rejects pre-cancelled or read-only exports', async () => {
  const f = await exportContext(true);
  try {
    const output = path.join(f.workspace, 'alias.html');
    await link(f.notebookPath, output);
    await expect(assertExportDestination(f.ctx.fence, f.notebookPath, output, 'html', true, process.platform)).rejects.toMatchObject({ code: 'invalid_arguments' });
    const args = { path: f.notebookPath, format: 'html' };
    expect(await handleNotebookExport(f.ctx, args)).toMatchObject({ error: { code: 'read_only_mode' } });
    expect(await handleNotebookExport({ ...f.ctx, config: { ...f.ctx.config, readOnly: false } }, args, AbortSignal.abort())).toMatchObject({ error: { code: 'cancelled' } });
    expect(await readFile(f.notebookPath, 'utf8')).toBe(f.source);
  } finally {
    await f.close();
  }
});

it('[EXPORT][U27] publishes at most one of two competing exports without overwriting the winner', async () => {
  const f = await exportContext();
  try {
    const first = path.join(f.workspace, 'first.tmp');
    const second = path.join(f.workspace, 'second.tmp');
    const output = path.join(f.workspace, 'race.html');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    const results = await Promise.allSettled([publishExportFile(first, output, false), publishExportFile(second, output, false)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(['first', 'second']).toContain(await readFile(output, 'utf8'));
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'invalid_arguments' } });
  } finally {
    await f.close();
  }
});

it('[EXPORT][U27] describes a missing browser without spawning processes or returning base64', () => {
  expect(() => findExportBrowser('linux', { PATH: '/none' }, () => false)).toThrow('requires a local Chrome');
  const result = toCallToolResult({ payload: { output_path: '/report.html', format: 'html', warnings: [] } });
  expect(result.content).toHaveLength(1);
});
