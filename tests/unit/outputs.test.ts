import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collectOutputWarnings,
  dropUnrepresentableOutputs,
  mapRawOutputs,
  rawOutputsOfCell,
  type RawOutput,
} from '../../src/core/outputs.js';
import { exactNumber } from '../../src/core/json-exact.js';
import { parseNotebook } from '../../src/core/parse.js';
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
    // The stored value IS the string `{"a":1}` — nbformat puts no type constraint on
    // a json mime, so emitting `{a: 1}` would show the model a value the file does
    // not contain. This assertion used to require the parsed object, which is the
    // behaviour v8 V8-2 identified as silently rewriting data.
    expect(items[2]).toMatchObject({ kind: 'json', value: '{"a":1}' });
    expect(items[3]).toMatchObject({ kind: 'text', text: '42' });
    // `+json` is a json mime by nbformat's own rule (`^application/(.*\+)?json$`),
    // the same rule the write side uses to keep the value. Reporting it as
    // `unsupported` meant a value that was written to the file could not be read
    // back — and this assertion used to PIN that behaviour (review v8 V8-1).
    expect(items[4]).toMatchObject({ kind: 'json', value: '{}' });
  });

  it('emits a json-mime value unchanged, including one that is not valid JSON text', () => {
    // SPEC §5.4 row 7's "parse failure degrades to text" described a value that
    // cannot be represented as json. There is no such value: every JSON value is now
    // emittable as-is, so a string that merely LOOKS like broken JSON is still a
    // string and must survive as one. Degrading it to `text/plain` also rewrote the
    // mime, which is how `{'application/json': 'hello'}` lost its type entirely
    // (review v8 V8-2).
    const { items } = mapOutputs([{ outputType: 'execute_result', data: { 'application/json': '{broken' } }]);
    expect(items[0]).toStrictEqual({ kind: 'json', value: '{broken', warnings: [] });
  });

  it('[V9-5] a json integer too large for a double is reported, not silently rounded', () => {
    // The value is built as RAW FILE TEXT because `JSON.stringify` cannot carry it:
    // `String(18446744073709551616)` is already `18446744073709552000`, which is
    // exactly the bug — the model was handed a value the file does not contain, with
    // `warnings: []` (review v9 V9-5).
    const { items } = mapOutputs([
      { outputType: 'execute_result', data: { 'application/json': exactNumber('18446744073709551616') } },
    ]);
    const item = items[0];
    expect(item).toMatchObject({ kind: 'json' });
    const warnings = (item as { warnings: Array<{ code: string; message: string }> }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('output_truncated');
    // The exact digits must be IN the answer: the value that can be sent as a number
    // is the rounded one, so the warning is the only place they can survive.
    expect(warnings[0]!.message).toContain('18446744073709551616');
    // …and the lifted, call-level form carries the same message (SPEC §7's table is
    // where a client looks; the code is shared, which is why the message must be
    // self-describing).
    expect(collectOutputWarnings([{ outputs: items }]).map((warning) => warning.message))
      .toEqual([warnings[0]!.message]);
  });

  it('[V9-5] a json integer inside the safe range carries no warning', () => {
    const { items } = mapOutputs([{ outputType: 'display_data', data: { 'application/json': 2 ** 53 - 1 } }]);
    expect(items[0]).toStrictEqual({ kind: 'json', value: 9007199254740991, warnings: [] });
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

describe('[V8-2][V8-1] the READ direction preserves EVERY legal value for every mime', () => {
  // The hard rule this round adds (AGENTS §9): when a data shape is fixed, the
  // matrix of ALL its legal types comes with it, and each entry is proven to fail
  // before the fix. v7 fixed `application/json` for non-string values and stopped
  // there, so the string half of the same contract stayed broken (V8-2) and the
  // `+json` family was never touched (V8-1) — the reviewer's own re-verification
  // made the same mistake, which is why the rule is written down for both sides.
  //
  // nbformat puts NO type constraint on a json mime's value, so every one of these
  // is legal on disk and must reach the model unchanged:
  const JSON_TYPES: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['integer', 5],
    ['negative integer', -7],
    ['float', 2.5],
    ['empty string', ''],
    // A JSON STRING: the value the file holds is the string. Parsing it would turn
    // `"123"` into the NUMBER 123 — a different value, not a degradation (V8-2).
    ['numeric string', '123'],
    ['plain string', 'hello'],
    ['JSON-looking string', '{"k":1}'],
    ['string with newline', 'a\nb'],
    ['empty array', []],
    ['array of numbers', [1, 2, 3]],
    ['array of strings', ['a', 'b']],
    ['array of mixed types', [1, 'a', null, { b: true }]],
    ['empty object', {}],
    ['object', { k: 'v' }],
    ['nested object', { a: [1, 2, 3], b: { c: true } }],
  ];

  // Every mime nbformat treats as JSON (`patternProperties` is
  // `^application/(.*\+)?json$`), which is the SAME rule the write side already
  // uses through `isJsonMime`.
  const JSON_MIMES = [
    'application/json',
    'application/x+json',
    'application/vnd.custom+json',
    'application/x/y+json',
    'application/+json',
  ];

  const options = { maxImageBytes: 20_971_520, inlineTextChars: 20000, hasher };

  function project(mime: string, value: unknown): unknown {
    const doc = parseNotebook(new TextEncoder().encode(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        cell_type: 'code',
        id: 'c0',
        metadata: {},
        source: 'x',
        execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { [mime]: value }, metadata: {} }],
      }],
    })), hasher).doc;
    const cell = (doc.cells as readonly unknown[])[0] as Parameters<typeof rawOutputsOfCell>[0];
    return mapRawOutputs(rawOutputsOfCell(cell), options).items[0];
  }

  for (const mime of JSON_MIMES) {
    it.each(JSON_TYPES)(`${mime} with a %s value round-trips unchanged`, (label, value) => {
      // `toStrictEqual` on the whole item: `kind`, `value`, `warnings`, and the
      // absence of any other field. A weaker matcher would let the projection add a
      // `text`/`mime` field and still pass, which is how the mime rewrite went
      // unnoticed. `warnings` is asserted explicitly rather than skipped because it
      // is now part of the item's shape: a value that needs no warning must say so
      // with an empty array, not by omitting the field (review v9 V9-5).
      expect(project(mime, value), `${mime} / ${label}`).toStrictEqual({ kind: 'json', value, warnings: [] });
    });
  }

  it('a non-json mime still reports unsupported, not json', () => {
    // The mirror of the rule: widening `isJsonMime` must not swallow everything.
    expect(project('application/octet-stream', 'x')).toMatchObject({ kind: 'unsupported' });
    expect(project('text/x-custom', 'x')).toMatchObject({ kind: 'unsupported' });
  });

  it('an unsupported mime says the value is still in the file', () => {
    // V8-1: legal data the model cannot see must at least be reported as PRESERVED,
    // otherwise the model concludes the output is empty and rewrites the cell.
    const item = project('application/x-custom-binary', { k: 'v' }) as Record<string, unknown>;
    expect(item['kind']).toBe('unsupported');
    expect(String(item['message'])).toMatch(/preserved|kept|unchanged/i);
  });
});

describe('[V8-3] an image value the tool cannot decode says WHY', () => {
  const options = { maxImageBytes: 20_971_520, inlineTextChars: 20000, hasher };
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  function imageItem(value: string): Record<string, unknown> {
    const doc = parseNotebook(new TextEncoder().encode(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        cell_type: 'code',
        id: 'c0',
        metadata: {},
        source: 'x',
        execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { 'image/png': value }, metadata: {} }],
      }],
    })), hasher).doc;
    const cell = (doc.cells as readonly unknown[])[0] as Parameters<typeof rawOutputsOfCell>[0];
    const result = mapRawOutputs(rawOutputsOfCell(cell), options);
    return { ...(result.items[0] as Record<string, unknown>), __decodeFailed: result.extractedImages[0]?.decodeFailed };
  }

  it('plain base64 materializes (the control)', () => {
    const item = imageItem(PNG_1PX);
    expect(item).toMatchObject({ kind: 'image', bytes: expect.any(Number) });
    expect(item['bytes'] as number).toBeGreaterThan(0);
    expect(item['__decodeFailed']).toBe(false);
  });

  it('a data-URL is accepted by stripping the prefix (it is what users paste)', () => {
    // Jupyter cannot render `data:image/png;base64,...` either, but a user CAN paste
    // it into a cell and it is unambiguous. Refusing it produced a zero-byte image
    // with only "materialize failed" as an explanation (review v8 V8-3).
    const item = imageItem(`data:image/png;base64,${PNG_1PX}`);
    expect(item).toMatchObject({ kind: 'image' });
    expect(item['bytes'] as number).toBeGreaterThan(0);
    expect(item['__decodeFailed']).toBe(false);
  });

  it('a value that is neither says so, instead of implying an empty image', () => {
    const item = imageItem('not base64 at all!!');
    expect(item).toMatchObject({ kind: 'image', bytes: 0, artifact_path: null });
    // The model must be able to tell "this is broken" from "this is empty".
    expect(JSON.stringify(item)).toMatch(/decode|invalid|not valid|characters/i);
  });
});
describe('[P1-b] text-bearing mimes are narrowed before they reach the model', () => {
  // The write direction narrows a mime value before storing it; the response
  // contract did not, so `display({'text/plain': 5}, raw=True)` came back as
  // `text: 5` — a number in a field declared `text: string` — while the same
  // output was stored as `data: {}` (review v7 P1-b).
  const options = { maxImageBytes: 20_971_520, inlineTextChars: 20000, hasher };

  it.each([
    ['text/plain', 5],
    ['text/plain', { nested: true }],
    ['text/markdown', 7],
    // An array of strings is the OTHER legal nbformat shape and still joins
    // (`dataValueToString`); an object is not representable at all.
    ['text/html', { nested: true }],
  ] as ReadonlyArray<readonly [string, unknown]>)('%s with a non-string value yields a string', (mime, value) => {
    const mapped = mapRawOutputs([{ outputType: 'display_data', data: { [mime]: value }, metadata: {} }], options);
    const item = mapped.items[0] as Record<string, unknown>;
    for (const field of ['text', 'html', 'text_fallback']) {
      if (field in item) {
        expect(typeof item[field], `${mime} ${field} must be a string`).toBe('string');
      }
    }
  });

  it('an unrepresentable html value yields empty html, not invented content', () => {
    const mapped = mapRawOutputs(
      [{ outputType: 'display_data', data: { 'text/html': { nested: true } }, metadata: {} }],
      options,
    );
    expect(mapped.items[0]).toMatchObject({ kind: 'html', html: '' });
  });

  it('a string ARRAY is still joined rather than dropped (the other legal shape)', () => {
    const mapped = mapRawOutputs(
      [{ outputType: 'display_data', data: { 'text/html': ['<b>a</b>', '<i>b</i>'] }, metadata: {} }],
      options,
    );
    expect(mapped.items[0]).toMatchObject({ kind: 'html', html: '<b>a</b><i>b</i>' });
  });

  it('a non-string text/plain never becomes an image fallback either', () => {
    const mapped = mapRawOutputs(
      [{ outputType: 'display_data', data: { 'image/png': 123, 'text/plain': 5 }, metadata: {} }],
      options,
    );
    // The fallback describes the IMAGE problem instead of the unusable
    // `text/plain` value: an empty string here reads as "the image is empty",
    // which is the distinction v8 V8-3 added and v9's matrix keeps (the field is
    // never filled with `5`, the stringified non-string value).
    const item = mapped.items[0];
    expect(item).toMatchObject({ kind: 'image' });
    expect(typeof (item as { text_fallback: string }).text_fallback).toBe('string');
    expect((item as { text_fallback: string }).text_fallback).not.toContain('5');
  });
});
