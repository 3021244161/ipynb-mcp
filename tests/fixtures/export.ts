import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseConfig } from '../../src/config.js';
import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { createLogger } from '../../src/log.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { RunStore } from '../../src/mcp/run-store.js';

export const EXPORT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';

export function exportFixture() {
  return {
    nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' }, custom: 'preserve' },
    cells: [
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: ['# 分析报告\n', '**Saved results** and `code`.\n\n', '| Name | Value |\n| --- | --- |\n| 中文 | 42 |\n\n', '![Attachment](attachment:plot.png)'], attachments: { 'plot.png': { 'image/png': EXPORT_PNG } } },
      { id: 'code', cell_type: 'code', metadata: {}, source: 'raise RuntimeError("MUST NOT EXECUTE")', execution_count: 3, outputs: [
        { output_type: 'stream', name: 'stdout', text: ['saved text\n', '中文与 emoji 😀\n', 'C:\\Users\\report\n'] },
        { output_type: 'display_data', metadata: {}, data: { 'text/html': '<table><thead><tr><th>Column</th></tr></thead><tbody><tr><td>42</td></tr></tbody></table>', 'text/plain': 'DO NOT DUPLICATE HTML FALLBACK' } },
        { output_type: 'display_data', metadata: {}, data: { 'image/png': [EXPORT_PNG], 'text/plain': 'DO NOT DUPLICATE IMAGE FALLBACK' } },
        { output_type: 'display_data', metadata: {}, data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#317f9b"/></svg>' } },
        { output_type: 'error', ename: 'ValueError', evalue: 'saved failure', traceback: ['ValueError: saved failure'] },
      ] },
      { id: 'raw', cell_type: 'raw', metadata: {}, source: 'raw <literal>' },
    ],
  };
}

export async function exportContext(readOnly = false) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-export-test-'));
  const notebookPath = path.join(workspace, '报告.ipynb');
  const source = JSON.stringify(exportFixture());
  await writeFile(notebookPath, source);
  const config = parseConfig(['--root', workspace, '--artifact-dir', path.join(workspace, 'artifacts'), ...(readOnly ? ['--read-only'] : [])], {}).config!;
  const registry = new KernelRegistry({ idleSeconds: 3600 });
  const ctx: ToolContext = {
    config, registry, runStore: new RunStore(), fence: new PathFence(workspace, false, process.platform),
    hasher, logger: createLogger('error'), realpath: realpathSync, platform: process.platform,
  };
  return { ctx, workspace, notebookPath, source, close: async () => {
    await registry.shutdownAll();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
