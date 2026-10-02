// Step 9 unit tests: read projection (U21/U21b) — the default summary read
// stays bounded on a 500-cell notebook, and a full read truncates with
// exactly one output_truncated warning.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

/** A display_data output carrying a 1x1 PNG whose bytes differ per index. */
function pngOutput(index: number): Record<string, unknown> {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  bytes[19] = 1; // width
  bytes[23] = 1; // height
  bytes[24] = index; // make every image's content unique
  return { output_type: 'display_data', data: { 'image/png': Buffer.from(bytes).toString('base64') } };
}

function imageCells(perCell: readonly number[]): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python' } },
    cells: perCell.map((count, cellIndex) =>
      cell(cellIndex, Array.from({ length: count }, (_, i) => pngOutput(cellIndex * 100 + i))),
    ),
  });
}

function imageIndexes(payload: Record<string, unknown>): number[] {
  const cells = payload['cells'] as Array<Record<string, unknown>>;
  const indexes: number[] = [];
  for (const entry of cells) {
    for (const item of (entry['outputs'] as Array<Record<string, unknown>> | null) ?? []) {
      if (item['kind'] === 'image' && item['image_index'] !== null) {
        indexes.push(Number(item['image_index']));
      }
    }
  }
  return indexes.sort((a, b) => a - b);
}

describe('[A5][W4] the image budget is call-wide, not per cell', () => {
  it('cell 1 using 9 of 20 does not shrink cell 2 to the remainder', async () => {
    // The old read path passed a REMAINING budget against an ABSOLUTE cursor,
    // so cell 2 was cut at imageIndex 11 while only 11 images existed: 3 of
    // its 5 images were dropped and image_limit was reported for images that
    // fit inside the call-wide limit (review W4).
    const notebook = parseNotebook(new TextEncoder().encode(imageCells([9, 5])), hasher);
    const { payload, imageBlocks } = await render(notebook, 'full');
    expect(imageIndexes(payload)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(imageBlocks).toHaveLength(14);
    expect((payload['warnings'] as Array<Record<string, unknown>>).map((w) => w['code']))
      .not.toContain('image_limit');
  });

  it('stops at max_images_per_call and warns exactly once across cells', async () => {
    const notebook = parseNotebook(new TextEncoder().encode(imageCells([12, 20])), hasher);
    const { payload, imageBlocks } = await render(notebook, 'full');
    // 20 is the call-wide cap: cell 0's 12 plus the first 8 of cell 1.
    expect(imageIndexes(payload)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(imageBlocks).toHaveLength(20);
    const warnings = (payload['warnings'] as Array<Record<string, unknown>>)
      .filter((w) => w['code'] === 'image_limit');
    expect(warnings).toHaveLength(1);
  });

  it('max_images_per_call=0 returns no images and no artifacts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-render0-'));
    try {
      const notebook = parseNotebook(new TextEncoder().encode(imageCells([3])), hasher);
      const { imageBlocks } = await renderReadResult({
        notebook,
        path: 'C:/work/nb.ipynb',
        includeSource: 'preview',
        includeOutputs: 'full',
        previewLines: 12,
        imagesPolicy: 'auto',
        maxImagesPerCall: 0,
        maxImageBytes: 20971520,
        inlineTextChars: 20000,
        artifactDir: path.join(dir, 'artifacts'),
        platform: 'win32',
        realpath: (target) => target,
        hasher,
      });
      expect(imageBlocks).toEqual([]);
      const artifacts = await readdir(path.join(dir, 'artifacts')).catch(() => []);
      expect(artifacts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('[step9] read projection details', () => {  it('respects cell_indexes filtering and include_source=none', async () => {
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
