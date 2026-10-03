import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dropUnrepresentableOutputs, mapRawOutputs, type RawOutput } from '../../src/core/outputs.js';
import { applyImagePolicy, shouldReturnImages } from '../../src/fs/artifact.js';
import { hasher } from '../../src/hash.js';

let artifactRoot: string;
let notebookPath: string;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-artifact-'));
  artifactRoot = path.join(dir, 'artifacts');
  notebookPath = path.join(dir, 'nb.ipynb');
});

afterAll(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

// --- tiny hand-built images -------------------------------------------------

function makePng(width: number, height: number, pad = 0): Uint8Array {
  const bytes = new Uint8Array(24 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function makeJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(17);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  bytes[7] = (height >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >>> 8) & 0xff;
  bytes[10] = width & 0xff;
  bytes.set([0x03, 0x01, 0x11, 0x00, 0xff, 0xd9], 11);
  return bytes;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function pngOutput(width: number, height: number, pad = 0, extra: Record<string, string> = {}): RawOutput {
  return {
    outputType: 'display_data',
    data: { 'image/png': b64(makePng(width, height, pad)), ...extra },
  };
}

function mapOutputs(raws: readonly RawOutput[], overrides?: Partial<{ inlineTextChars: number; maxImageBytes: number }>) {
  return mapRawOutputs(raws, {
    inlineTextChars: overrides?.inlineTextChars ?? 20000,
    maxImageBytes: overrides?.maxImageBytes ?? 20971520,
    hasher,
  });
}

async function countArtifactFiles(): Promise<number> {
  try {
    const entries = await readdir(artifactRoot, { recursive: true });
    return entries.filter((entry) => typeof entry === 'string' && (entry.endsWith('.png') || entry.endsWith('.jpg'))).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------

describe('[step6] mapRawOutputs ordered dispatch (SPEC §5.4)', () => {
  it('maps streams with truncation flags', () => {
    const long = 'x'.repeat(50);
    const { items } = mapOutputs([{ outputType: 'stream', name: 'stdout', text: long }], { inlineTextChars: 10 });
    const item = items[0]!;
    expect(item.kind).toBe('stream');
    if (item.kind === 'stream') {
      expect(item.text).toBe('x'.repeat(10));
      expect(item.truncated).toBe(true);
      expect(item.truncated_at_chars).toBe(10);
      expect(item.stream_name).toBe('stdout');
    }
    const short = mapOutputs([{ outputType: 'stream', name: 'stderr', text: 'ok' }]).items[0]!;
    expect(short).toMatchObject({ kind: 'stream', truncated: false, truncated_at_chars: null, stream_name: 'stderr' });
  });

  it('keeps only the last 20 traceback lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const { items } = mapOutputs([{ outputType: 'error', ename: 'ValueError', evalue: 'bad', traceback: lines }]);
    const item = items[0]!;
    expect(item.kind).toBe('error');
    if (item.kind === 'error') {
      expect(item.error_name).toBe('ValueError');
      expect(item.traceback_lines).toHaveLength(20);
      expect(item.traceback_lines[0]).toBe('line-10');
    }
  });

  it('image/png wins over other mimes (order 3 before 5/6/8)', () => {
    const { items } = mapOutputs([{
      outputType: 'display_data',
      data: { 'text/markdown': '**bold**', 'text/html': '<b>bold</b>', 'image/png': b64(makePng(3, 4)) },
    }]);
    expect(items[0]!.kind).toBe('image');
  });

  it('maps markdown, html with fallback, json, text and unknown', () => {
    const { items } = mapOutputs([
      { outputType: 'display_data', data: { 'text/markdown': '# hi' } },
      { outputType: 'display_data', data: { 'text/html': '<p>x</p>', 'text/plain': 'x' } },
      { outputType: 'execute_result', data: { 'application/json': '{"a":1}' } },
      { outputType: 'execute_result', data: { 'text/plain': '42' } },
      { outputType: 'display_data', data: { 'application/vnd.foo+json': '{}' } },
    ]);
    expect(items[0]).toMatchObject({ kind: 'markdown', text: '# hi' });
    expect(items[1]).toMatchObject({ kind: 'html', html: '<p>x</p>', text_fallback: 'x' });
    expect(items[2]).toMatchObject({ kind: 'json', value: { a: 1 } });
    expect(items[3]).toMatchObject({ kind: 'text', text: '42' });
    expect(items[4]).toMatchObject({ kind: 'unsupported', mime_type: 'application/vnd.foo+json' });
  });

  it('degrades unparseable application/json to text', () => {
    const { items } = mapOutputs([{ outputType: 'execute_result', data: { 'application/json': '{broken' } }]);
    expect(items[0]).toMatchObject({ kind: 'text', text: '{broken' });
  });

  it('parses png/jpeg dimensions from headers, metadata takes priority', () => {
    const withMeta = mapOutputs([{
      outputType: 'display_data',
      data: { 'image/png': b64(makePng(3, 4)) },
      metadata: { width: 640, height: 480 },
    }]).items[0]!;
    expect(withMeta).toMatchObject({ kind: 'image', width: 640, height: 480 });

    const parsed = mapOutputs([pngOutput(320, 200)]).items[0]!;
    expect(parsed).toMatchObject({ kind: 'image', width: 320, height: 200 });

    const jpeg = mapOutputs([{
      outputType: 'display_data',
      data: { 'image/jpeg': b64(makeJpeg(120, 80)) },
    }]).items[0]!;
    expect(jpeg).toMatchObject({ kind: 'image', media_type: 'image/jpeg', width: 120, height: 80 });
  });
});

describe('[step6][U15] 30 images: kind image everywhere, no base64 in text', () => {
  it('returns image items without leaking decodable base64 payloads', async () => {
    const raws = Array.from({ length: 30 }, () => pngOutput(10, 10, 40));
    const { items, extractedImages } = mapOutputs(raws);

    expect(items).toHaveLength(30);
    expect(items.every((item) => item.kind === 'image')).toBe(true);

    // Materialize with the default cap of 20.
    const result = await applyImagePolicy(
      items,
      extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 0, platform: 'win32', realpath: (p) => p },
    );
    expect(result.materialized).toHaveLength(20);
    expect(result.warnings.map((w) => w.code)).toContain('image_limit');

    // The rendered JSON must not contain ANY decodable PNG/JPEG payload
    // (review D5): rather than grepping for two literal prefixes, find every
    // base64-shaped run and check the decoded magic bytes — an encoding or
    // prefix change can no longer slip through.
    const json = JSON.stringify(result.items);
    expect(decodableImagePayloads(json)).toEqual([]);
    const withIndex = result.items.filter((item) => item.kind === 'image' && item.image_index !== null);
    expect(withIndex).toHaveLength(20);
    const withoutIndex = result.items.filter((item) => item.kind === 'image' && item.image_index === null);
    expect(withoutIndex).toHaveLength(10);
    for (const item of withoutIndex) {
      if (item.kind === 'image') {
        expect(item.artifact_path).toBeNull();
      }
    }
  });
});

describe('[step6][U16] oversized image becomes unsupported without artifacts', () => {
  it('maps to unsupported and writes nothing', async () => {
    const before = await countArtifactFiles();
    const { items, extractedImages } = mapOutputs([pngOutput(5, 5, 400)], { maxImageBytes: 100 });
    expect(items[0]).toMatchObject({ kind: 'unsupported', mime_type: 'image/png' });
    expect(extractedImages).toHaveLength(0);

    const result = await applyImagePolicy(
      items,
      extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 1, platform: 'win32', realpath: (p) => p },
    );
    expect(result.materialized).toHaveLength(0);
    expect(await countArtifactFiles()).toBe(before);
  });
});

describe('[step6][U17] --images=never keeps everything null', () => {
  it('produces image items with null paths and zero artifact files', async () => {
    const before = await countArtifactFiles();
    const { items, extractedImages } = mapOutputs([pngOutput(2, 2), pngOutput(3, 3)]);
    const result = await applyImagePolicy(
      items,
      extractedImages,
      { returnImages: shouldReturnImages('never', true), maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 2, platform: 'win32', realpath: (p) => p },
    );
    expect(result.materialized).toHaveLength(0);
    for (const item of result.items) {
      if (item.kind === 'image') {
        expect(item.artifact_path).toBeNull();
        expect(item.image_index).toBeNull();
      }
    }
    expect(await countArtifactFiles()).toBe(before);
  });
});

describe('[step6][U26] materialization happens only when blocks are returned', () => {
  it('summary read: nulls and no files; full read: real paths and files', async () => {
    const before = await countArtifactFiles();

    // Summary (auto policy, outputsFull=false): nothing materializes.
    {
      const { items, extractedImages } = mapOutputs([pngOutput(4, 4)]);
      const result = await applyImagePolicy(
        items,
        extractedImages,
        { returnImages: shouldReturnImages('auto', false), maxImages: 20 },
        { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 3, platform: 'win32', realpath: (p) => p },
      );
      const image = result.items[0]!;
      expect(image.kind).toBe('image');
      if (image.kind === 'image') {
        expect(image.artifact_path).toBeNull();
        expect(image.image_index).toBeNull();
      }
      expect(await countArtifactFiles()).toBe(before);
    }

    // Full (auto policy, outputsFull=true): materializes.
    {
      const { items, extractedImages } = mapOutputs([pngOutput(4, 4)]);
      const result = await applyImagePolicy(
        items,
        extractedImages,
        { returnImages: shouldReturnImages('auto', true), maxImages: 20 },
        { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 3, platform: 'win32', realpath: (p) => p },
      );
      const image = result.items[0]!;
      expect(image.kind).toBe('image');
      if (image.kind === 'image') {
        expect(image.artifact_path).not.toBeNull();
        expect(image.image_index).toBe(0);
      }
      expect(await countArtifactFiles()).toBe(before + 1);
    }
  });

  it('re-materializing identical content hits the same file (idempotent)', async () => {
    const png = pngOutput(6, 6);
    const first = mapOutputs([png]);
    const firstResult = await applyImagePolicy(
      first.items,
      first.extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 7, platform: 'win32', realpath: (p) => p },
    );
    const second = mapOutputs([png]);
    const secondResult = await applyImagePolicy(
      second.items,
      second.extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 7, platform: 'win32', realpath: (p) => p },
    );
    expect(secondResult.materialized[0]!.artifactPath).toBe(firstResult.materialized[0]!.artifactPath);
    expect(secondResult.warnings).toEqual([]);
  });

  it('win32/darwin case folding feeds the artifact directory key', async () => {
    const upper = mapOutputs([pngOutput(2, 2)]);
    const resultUpper = await applyImagePolicy(
      upper.items,
      upper.extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: 'C:/Work/NB.ipynb', cellIndex: 0, platform: 'win32', realpath: (p) => p },
    );
    const lower = mapOutputs([pngOutput(2, 2)]);
    const resultLower = await applyImagePolicy(
      lower.items,
      lower.extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: 'c:/work/nb.ipynb', cellIndex: 0, platform: 'win32', realpath: (p) => p },
    );
    expect(resultUpper.materialized[0]!.artifactPath).toBe(resultLower.materialized[0]!.artifactPath);
  });
});

describe('[step6] decode failures surface as image with warning', () => {
  it('keeps kind image with null fields and warns image_materialize_failed', async () => {
    const { items, extractedImages } = mapOutputs([{
      outputType: 'display_data',
      data: { 'image/png': '!!!not-base64!!!' },
    }]);
    expect(items[0]!.kind).toBe('image');
    const result = await applyImagePolicy(
      items,
      extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 9, platform: 'win32', realpath: (p) => p },
    );
    expect(result.materialized).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('image_materialize_failed');
    const image = result.items[0]!;
    if (image.kind === 'image') {
      expect(image.artifact_path).toBeNull();
      expect(image.image_index).toBeNull();
    }
  });
});

describe('[step6][A5] image_index stays unique across cells in one call', () => {
  it('two cells with one image each get indexes 0 and 1 (SPEC §4.3)', async () => {
    let cursor = 0;
    const cellIndexes = [0, 1];
    const allIndexes: number[] = [];
    for (const cellIndex of cellIndexes) {
      const { items, extractedImages } = mapOutputs([pngOutput(2, 2)]);
      const result = await applyImagePolicy(
        items,
        extractedImages,
        { returnImages: true, maxImages: 20, indexStart: cursor },
        { artifactRoot, notebookAbsPath: notebookPath, cellIndex, platform: 'win32', realpath: (p) => p },
      );
      cursor += result.materialized.length;
      for (const item of result.items) {
        if (item.kind === 'image') {
          allIndexes.push(item.image_index ?? -1);
        }
      }
    }
    expect(allIndexes).toEqual([0, 1]);
  });
});

/** Returns base64 runs that decode to a PNG/JPEG magic header (should be none). */
function decodableImagePayloads(json: string): string[] {
  const candidates = json.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? [];
  return candidates.filter((candidate) => {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(candidate, 'base64');
    } catch {
      return false;
    }
    if (bytes.length < 4) {
      return false;
    }
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return isPng || isJpeg;
  });
}

describe('[D7] exactly max_images_per_call images: no limit warning (SPEC §4.4)', () => {
  it('materializes all 20 and emits no image_limit', async () => {
    const raws = Array.from({ length: 20 }, () => pngOutput(10, 10, 40));
    const { items, extractedImages } = mapOutputs(raws);
    const result = await applyImagePolicy(
      items,
      extractedImages,
      { returnImages: true, maxImages: 20 },
      { artifactRoot, notebookAbsPath: notebookPath, cellIndex: 0, platform: 'win32', realpath: (p) => p },
    );
    expect(result.materialized).toHaveLength(20);
    expect(result.warnings.map((w) => w.code)).not.toContain('image_limit');
    const indexed = result.items.filter((item) => item.kind === 'image' && item.image_index !== null);
    expect(indexed).toHaveLength(20);
    // Indexes are 0..19 with no duplicates or gaps.
    const indexes = indexed
      .map((item) => (item.kind === 'image' ? item.image_index : null))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    expect(indexes).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

describe('[GATE-5][CRASH-1] values nbformat cannot store', () => {
  // A plain user cell can send any JSON value for a mime key:
  //   display({'text/plain': 5}, raw=True)   -> invalid nbformat on disk,
  //                                             reported as success with no warning
  //   display({'image/png': 123}, raw=True)  -> aborted the run with `internal` /
  //                                             "base64.replace is not a function"
  // Both were reproduced with a real kernel in review v6. The write gate refuses
  // such a file (correct), so the EXECUTION path must not build one — otherwise
  // one output value destroys an entire run's work.

  it('mapRawOutputs survives a non-string image value instead of throwing', () => {
    const result = mapRawOutputs(
      // The type says string; the KERNEL does not have to agree, which is the
      // whole point of the case (review v6 CRASH-1 reproduced it with a real one).
      [{ outputType: 'display_data', data: { 'image/png': 123 as unknown as string }, metadata: {} }],
      { maxImageBytes: 20_971_520, inlineTextChars: 20000, hasher },
    );
    // Routed to the documented "image could not be materialized" path: an image
    // item with nulls plus a decodeFailed marker, never a TypeError.
    expect(result.items[0]).toMatchObject({
      kind: 'image',
      media_type: 'image/png',
      artifact_path: null,
      image_index: null,
      bytes: 0,
    });
    expect(result.extractedImages[0]).toMatchObject({ decodeFailed: true });
  });

  it('dropUnrepresentableOutputs removes only the values nbformat forbids', () => {
    const dropped = dropUnrepresentableOutputs([
      // A number where the schema wants a string (or a list of strings)…
      { output_type: 'display_data', data: { 'text/plain': 5, 'text/html': '<b>ok</b>' }, metadata: {} },
      // …an array with a non-string element…
      { output_type: 'display_data', data: { 'text/plain': ['ok', 5] }, metadata: {} },
      // …and a negative execution count (schema `minimum: 0`).
      { output_type: 'execute_result', data: { 'text/plain': '7' }, metadata: {}, execution_count: -1 },
      // JSON mime types are the documented exception: any value is legal.
      { output_type: 'display_data', data: { 'application/json': { any: ['thing'] } }, metadata: {} },
      // Representable entries must pass through untouched.
      { output_type: 'display_data', data: { 'text/plain': 'fine' }, metadata: {} },
      { output_type: 'stream', name: 'stdout', text: 'hi' },
    ]);

    expect(dropped.droppedMimes).toEqual(['text/plain', 'text/plain']);
    const [first, second, third, fourth] = dropped.outputs as Array<Record<string, unknown>>;
    // The good mime type in the same output survives: only the value is dropped.
    expect(first!['data']).toEqual({ 'text/html': '<b>ok</b>' });
    expect(second!['data']).toEqual({});
    expect(third!['execution_count']).toBeNull();
    expect(fourth!['data']).toEqual({ 'application/json': { any: ['thing'] } });
    expect(dropped.outputs).toHaveLength(6);
  });

  it('the write gate still refuses the same shapes (defence in depth)', async () => {
    const { findStructuralProblem, parseNotebook } = await import('../../src/core/parse.js');
    const doc = (output: Record<string, unknown>) => parseNotebook(new TextEncoder().encode(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x', execution_count: 1, outputs: [output] }],
    })), hasher).doc;

    expect(findStructuralProblem(doc({ output_type: 'display_data', data: { 'text/plain': 5 }, metadata: {} })))
      .toMatchObject({ rule: 'output_data_value_not_a_string', mime: 'text/plain' });
    expect(findStructuralProblem(doc({ output_type: 'display_data', data: { 'text/plain': ['ok', 5] }, metadata: {} })))
      .toMatchObject({ rule: 'output_data_value_not_a_string' });
    expect(findStructuralProblem(doc({
      output_type: 'execute_result', data: { 'text/plain': '7' }, metadata: {}, execution_count: -1,
    }))).toMatchObject({ rule: 'execute_result_execution_count_negative' });
    // `application/json` really is exempt, or the gate would reject valid files.
    expect(findStructuralProblem(doc({
      output_type: 'display_data', data: { 'application/json': { any: 1 } }, metadata: {},
    }))).toBeNull();
  });
});
