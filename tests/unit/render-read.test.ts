// Step 9 unit tests: read projection (U21/U21b) — the default summary read
// stays bounded on a 500-cell notebook, and a full read truncates with
// exactly one output_truncated warning.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { renderReadResult } from '../../src/mcp/render/read.js';

let artifactRoot: string;

beforeAll(async () => {
  artifactRoot = path.join(await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-render-')), 'artifacts');
});

afterAll(async () => {
  await rm(path.dirname(artifactRoot), { recursive: true, force: true });
});

function cell(index: number, outputs: unknown[], source = 'x = 1'): Record<string, unknown> {
  return {
    cell_type: 'code',
    id: `c${index}`,
    metadata: {},
    source,
    outputs,
    execution_count: 1,
  };
}

function bigNotebookJson(): string {
  const cells: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 499; i += 1) {
    cells.push(cell(i, [{ output_type: 'stream', name: 'stdout', text: `line ${i}\n` }]));
  }
  // One cell with a 100 KB stream output.
  cells.push(cell(499, [{ output_type: 'stream', name: 'stdout', text: 'x'.repeat(100 * 1024) }]));
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python', version: '3.11.9' } },
    cells,
  });
}

function render(notebook: ReturnType<typeof parseNotebook>, includeOutputs: 'summary' | 'full') {
  return renderReadResult({
    notebook,
    path: 'C:/work/nb.ipynb',
    includeSource: 'preview',
    includeOutputs,
    previewLines: 12,
    imagesPolicy: 'auto',
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    inlineTextChars: 20000,
    artifactDir: artifactRoot,
    platform: 'win32',
    realpath: (target) => target,
    hasher,
  });
}

describe('[step9][U21] summary read stays bounded on a 500-cell notebook', () => {
  it('returns a controlled payload size and no output_truncated warning', async () => {
    const notebook = parseNotebook(new TextEncoder().encode(bigNotebookJson()), hasher);
    const { payload, imageBlocks } = await render(notebook, 'summary');
    expect(imageBlocks).toEqual([]); // summary never materializes images (U26)
    const cells = payload['cells'] as Array<Record<string, unknown>>;
    expect(cells).toHaveLength(500);
    const summary = cells[499]!['outputs_summary'] as Array<Record<string, unknown>>;
    expect(summary[0]!['kind']).toBe('stream');
    // 160-char preview, not the full 100 KB.
    expect(String(summary[0]!['preview']).length).toBeLessThanOrEqual(161);
    const warnings = payload['warnings'] as Array<Record<string, unknown>>;
    expect(warnings.map((w) => w['code'])).not.toContain('output_truncated');
    // Total payload: bounded (the untruncated version would be ~50 MB).
    expect(JSON.stringify(payload).length).toBeLessThan(600_000);
  });
});

describe('[step9][U21b] full read truncates the stream exactly once', () => {
  it('flags truncated=true with truncated_at_chars and a single warning', async () => {
    const notebook = parseNotebook(new TextEncoder().encode(bigNotebookJson()), hasher);
    const { payload } = await render(notebook, 'full');
    const cells = payload['cells'] as Array<Record<string, unknown>>;
    const outputs = cells[499]!['outputs'] as Array<Record<string, unknown>>;
    expect(outputs[0]).toMatchObject({
      kind: 'stream',
      truncated: true,
      truncated_at_chars: 20000,
    });
    const warnings = payload['warnings'] as Array<Record<string, unknown>>;
    const truncatedWarnings = warnings.filter((w) => w['code'] === 'output_truncated');
    expect(truncatedWarnings).toHaveLength(1);
  });
});

describe('[step9] read projection details', () => {
  it('respects cell_indexes filtering and include_source=none', async () => {
    const json = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [cell(0, []), cell(1, []), { cell_type: 'markdown', id: 'm', metadata: {}, source: '# hi' }],
    });
    const notebook = parseNotebook(new TextEncoder().encode(json), hasher);
    const { payload } = await renderReadResult({
      notebook,
      path: 'C:/work/nb.ipynb',
      cellIndexes: [2, 0],
      includeSource: 'none',
      includeOutputs: 'none',
      previewLines: 12,
      imagesPolicy: 'auto',
      maxImagesPerCall: 20,
      maxImageBytes: 20971520,
      inlineTextChars: 20000,
      artifactDir: artifactRoot,
      platform: 'win32',
      realpath: (target) => target,
      hasher,
    });
    const cells = payload['cells'] as Array<Record<string, unknown>>;
    expect(cells.map((c) => c['cell_index'])).toEqual([0, 2]); // sorted ascending
    expect(cells[0]!['source_preview']).toEqual([]);
    expect(cells[0]!['source']).toBeNull();
    expect(cells[1]!['execution_count']).toBeNull(); // markdown cells
    expect(payload['has_stable_cell_ids']).toBe(true);
    expect(payload['kernel_name']).toBeNull();
  });
});
