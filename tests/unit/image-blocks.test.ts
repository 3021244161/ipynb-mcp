// V9-1/V9-2 regression tests: the layer the CONSUMER actually reads.
//
// The v8 fix for data-URL images touched the decode/materialize layer only, so a
// `data:` value decoded fine and was then handed to the SDK's `ImageContent.data`
// validator verbatim. `atob` rejected it, the SDK turned that into a protocol-level
// `-32602`, and the model lost the entire notebook — while every unit test passed,
// because the only assertions were on the internal `OutputItem` projection and on
// the NUMBER of image blocks (review v9 V9-1/V9-2, AGENTS §9's four layers).
//
// So these tests assert on `content[]` — the array the MCP client receives — and
// validate it with the SDK's own `CallToolResultSchema`, which is the same
// authority that produced the `-32602`. Nothing here inspects `OutputItem` to
// decide whether an image is returnable.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeBase64ToBytes, encodeBase64, isBase64Shaped } from '../../src/core/base64.js';
import type { JsonValue } from '../../src/core/errors.js';
import { parseNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { renderReadResult } from '../../src/mcp/render/read.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';

let artifactRoot: string;

beforeAll(async () => {
  artifactRoot = path.join(await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-imgblocks-')), 'artifacts');
});

afterAll(async () => {
  await rm(path.dirname(artifactRoot), { recursive: true, force: true });
});

// A 25-byte "PNG": 8-byte signature + IHDR length/type + width/height, which is
// all `parsePngSize` reads and all nbformat cares about. Deliberately not valid
// image data — the contract under test is the BLOCK payload, not the pixels.
function pngBytes(marker = 1): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x08], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  bytes[16] = 0;
  bytes[19] = 1; // width = 1
  bytes[23] = 1; // height = 1
  bytes[24] = marker;
  return bytes;
}

const PNG = pngBytes();
const PNG_B64 = encodeBase64(PNG);

/** One display_data output, with the image value under test. */
function notebookWithImageValue(value: unknown): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python' },
    },
    cells: [
      {
        cell_type: 'code',
        id: 'c0',
        metadata: {},
        source: 'display_img()',
        execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { 'image/png': value }, metadata: {} }],
      },
    ],
  });
}

interface Rendered {
  readonly content: ReturnType<typeof toCallToolResult>['content'];
  readonly payload: Record<string, unknown>;
}

/** A notebook with one broken image per cell, so the warnings must be attributable. */
function notebookWithBrokenImagePerCell(cellCount: number): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python' },
    },
    cells: Array.from({ length: cellCount }, (_, index) => ({
      cell_type: 'code',
      id: `c${String(index)}`,
      metadata: {},
      source: 'display_img()',
      execution_count: index + 1,
      // `'not base64!'` fails the decode in every cell, so the ONLY thing that can tell the
      // warnings apart is the cell index (review v11 V11-10).
      outputs: [{ output_type: 'display_data', data: { 'image/png': 'not base64!' }, metadata: {} }],
    })),
  });
}

async function readFull(json: string): Promise<Rendered> {
  const notebook = parseNotebook(new TextEncoder().encode(json), hasher);
  const rendered = await renderReadResult({
    notebook,
    path: path.join(path.dirname(artifactRoot), 'nb.ipynb'),
    includeSource: 'preview',
    includeOutputs: 'full',
    previewLines: 12,
    imagesPolicy: 'auto',
    maxImagesPerCall: 20,
    maxImageBytes: 20 * 1024 * 1024,
    inlineTextChars: 20000,
    artifactDir: artifactRoot,
    platform: 'win32',
    realpath: (target) => target,
    hasher,
  });
  const result = toCallToolResult({
    payload: rendered.payload as JsonValue,
    imageBlocks: rendered.imageBlocks,
  });
  return { content: result.content, payload: rendered.payload };
}

function imageBlocksOf(content: Rendered['content']): Array<{ data: string; mimeType: string }> {
  const blocks: Array<{ data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'image') {
      blocks.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

function firstOutputItem(payload: Record<string, unknown>): Record<string, unknown> {
  const cells = payload['cells'] as Array<Record<string, unknown>>;
  const outputs = cells[0]!['outputs'] as Array<Record<string, unknown>>;
  return outputs[0]!;
}

function warningCodes(payload: Record<string, unknown>): unknown[] {
  return ((payload['warnings'] as Array<Record<string, unknown>>) ?? []).map((warning) => warning['code']);
}

// ---------------------------------------------------------------------------
// The matrix. Every entry is a value a real notebook can legally hold (nbformat
// puts no constraint on an output's `data` value), and every entry is judged by
// the SAME two requirements: the call must not fail, and any image block that
// comes back must be decodable to the file's bytes.
// ---------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly value: unknown;
  /** Bytes the block must decode to, or null when no block may be returned. */
  readonly expectBytes: Uint8Array | null;
  /** The OutputItem kind expected when no block is returned (default `image`). */
  readonly kind?: 'image' | 'unsupported';
  /** Substring the zero-byte image's `text_fallback` must carry, when set. */
  readonly fallback?: string;
}

const CASES: readonly Case[] = [
  { name: 'plain base64', value: PNG_B64, expectBytes: PNG },
  // `atob` accepts unpadded input, `ImageContent.data` inherits that tolerance,
  // and some writers produce it — so the block must still be padded for clients
  // that are stricter than the validator (Buffer.from(..., 'base64') is not).
  { name: 'unpadded base64', value: PNG_B64.replace(/=+$/, ''), expectBytes: PNG },
  { name: 'data: URL with a matching label', value: `data:image/png;base64,${PNG_B64}`, expectBytes: PNG },
  // The mime KEY is the notebook's claim about the data; a label that disagrees
  // is the file's problem, not a reason to withhold an image the user can see.
  { name: 'data: URL with a mismatched label', value: `data:image/jpeg;base64,${PNG_B64}`, expectBytes: PNG },
  { name: 'data: URL with an empty media type', value: `data:;base64,${PNG_B64}`, expectBytes: PNG },
  { name: 'base64 wrapped over several lines', value: `${PNG_B64.slice(0, 8)}\n${PNG_B64.slice(8, 16)}\r\n${PNG_B64.slice(16)}`, expectBytes: PNG },
  // nbformat's documented multi-line form is an ARRAY of line strings. Joined, it
  // is a data URL (Jupyter writes the value that way for large images).
  { name: 'array of one data: URL line', value: [`data:image/png;base64,${PNG_B64}`], expectBytes: PNG },
  { name: 'array of base64 lines', value: [PNG_B64.slice(0, 8), PNG_B64.slice(8)], expectBytes: PNG },
  // Degradations: no block, a product-level warning, and the rest of the answer intact.
  { name: 'empty string', value: '', expectBytes: null },
  { name: 'whitespace only', value: '   \n ', expectBytes: null },
  { name: 'empty data: URL payload', value: 'data:image/png;base64,', expectBytes: null },
  // A non-string value is the documented `image_materialize_failed` case (SPEC
  // §4.4 / review v6 CRASH-1), and the item must still NAME the mime it came from.
  // The reason is in `text_fallback`, because `bytes: 0` plus a null artifact is
  // exactly what an EMPTY image looks like (review v8 V8-3).
  { name: 'non-string value', value: 123, expectBytes: null, fallback: 'not a string' },
  { name: 'null value', value: null, expectBytes: null, fallback: 'not a string' },
  { name: 'object value', value: { unexpected: true }, expectBytes: null, fallback: 'not a string' },
  // V9-1 residue (review v10): an array whose elements are NOT strings used to be joined
  // into `"123"`, which is valid base64 alphabet — so `[1,2,3]` was served as a real
  // 2-byte image WITH an artifact, and no warning. nbformat allows a string or an array
  // of strings; a mixed array is neither, and must degrade like any other bad value.
  { name: 'array of numbers', value: [1, 2, 3], expectBytes: null, fallback: 'not a string' },
  { name: 'array of mixed types', value: [PNG_B64, 7], expectBytes: null, fallback: 'not a string' },
  { name: 'array of objects', value: [{ a: 1 }], expectBytes: null, fallback: 'not a string' },
  // An empty array is `[]` for nbformat and joins to the empty string, so it takes the
  // "empty" exit rather than the "not a string" one — the distinction v8 V8-3 added, and
  // the reason the two messages exist separately.
  { name: 'empty array', value: [], expectBytes: null, fallback: 'empty' },
  { name: 'nested array', value: [[PNG_B64]], expectBytes: null, fallback: 'not a string' },
];

describe('[V9-1][V9-2] every returned image block is valid where the client reads it', () => {
  for (const testCase of CASES) {
    it(`[V9-1] ${testCase.name}: the whole tools/call result stays schema-valid`, async () => {
      const { content } = await readFull(notebookWithImageValue(testCase.value));
      // The SDK's own schema is the authority: `-32602 Invalid tools/call result`
      // is exactly this parse failing on the server's way out.
      const parsed = CallToolResultSchema.safeParse({ content });
      expect(parsed.success ? null : JSON.stringify(parsed.error.issues.slice(0, 2))).toBeNull();
      // The text block carries the model's answer and must always survive.
      expect(content[0]!.type).toBe('text');
    });

    it(`[V9-1] ${testCase.name}: the block decodes to the file's bytes, or no block is returned`, async () => {
      const { content, payload } = await readFull(notebookWithImageValue(testCase.value));
      const blocks = imageBlocksOf(content);
      const item = firstOutputItem(payload);
      if (testCase.expectBytes === null) {
        expect(blocks).toHaveLength(0);
        if ((testCase.kind ?? 'image') === 'unsupported') {
          expect(item).toMatchObject({ kind: 'unsupported', mime_type: 'image/png' });
          return;
        }
        expect(item).toMatchObject({ kind: 'image', bytes: 0, artifact_path: null, image_index: null });
        expect(warningCodes(payload)).toContain('image_materialize_failed');
        if (testCase.fallback !== undefined) {
          expect(String(item['text_fallback'])).toContain(testCase.fallback);
        }
        return;
      }
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.mimeType).toBe('image/png');
      expect(isBase64Shaped(blocks[0]!.data)).toBe(true);
      expect([...(decodeBase64ToBytes(blocks[0]!.data) ?? [])]).toEqual([...testCase.expectBytes]);
      // SPEC §4.4: materialization and returning a block are the same event, so a
      // returned block always has an artifact and an image_index behind it.
      expect(item).toMatchObject({ kind: 'image', bytes: PNG.length });
      expect(item['artifact_path']).not.toBeNull();
      expect(item['image_index']).toBe(0);
      expect(warningCodes(payload)).not.toContain('image_materialize_failed');
    });
  }

  it('[V9-2] the summary read never materializes even when the value is a data: URL', async () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookWithImageValue(`data:image/png;base64,${PNG_B64}`)),
      hasher,
    );
    const rendered = await renderReadResult({
      notebook,
      path: path.join(path.dirname(artifactRoot), 'nb.ipynb'),
      includeSource: 'preview',
      includeOutputs: 'summary',
      previewLines: 12,
      imagesPolicy: 'auto',
      maxImagesPerCall: 20,
      maxImageBytes: 20 * 1024 * 1024,
      inlineTextChars: 20000,
      artifactDir: artifactRoot,
      platform: 'win32',
      realpath: (target) => target,
      hasher,
    });
    expect(rendered.imageBlocks).toEqual([]);
  });
});

describe('[V9-3] one unservable block must not fail the whole call', () => {
  it('[V9-1] the OLD block source (the document value) is the thing the SDK rejects', () => {
    // The falsifiability anchor for this file, kept as a test so the regression
    // cannot silently come back: this is what the v8 code pushed, byte for byte —
    // the raw `data` value read back out of the document. If a future change makes
    // the SDK accept it, this test says so instead of the suite passing for the
    // wrong reason.
    const rawDocumentValue = `data:image/png;base64,${PNG_B64}`;
    const asOldCodeBuiltIt = { content: [{ type: 'image', data: rawDocumentValue, mimeType: 'image/png' }] };
    expect(CallToolResultSchema.safeParse(asOldCodeBuiltIt).success).toBe(false);
    // …and the same value through the current path is accepted.
    const result = toCallToolResult({
      payload: { warnings: [] } as unknown as JsonValue,
      imageBlocks: [{ data: PNG_B64, media_type: 'image/png' }],
    });
    expect(CallToolResultSchema.safeParse({ content: result.content }).success).toBe(true);
  });

  it('[V9-3] withholds the block, keeps the text answer, and warns in the payload', () => {
    // A producer bug, simulated at the last layer: this is the shape that used to
    // become `-32602` and cost the model everything else in the result.
    const result = toCallToolResult({
      payload: { path: 'C:/work/nb.ipynb', cells: [], warnings: [] } as unknown as JsonValue,
      imageBlocks: [
        { data: 'data:image/png;base64,iVBORw0KGgo=', media_type: 'image/png' },
        { data: PNG_B64, media_type: 'image/png' },
      ],
    });
    expect(CallToolResultSchema.safeParse({ content: result.content }).success).toBe(true);
    expect(imageBlocksOf(result.content)).toHaveLength(1);
    const body = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(warningCodes(body)).toContain('image_materialize_failed');
    // The payload itself is untouched apart from the appended warning.
    expect(body['path']).toBe('C:/work/nb.ipynb');
    expect(body['cells']).toEqual([]);
  });

  it('[V9-3] leaves a clean result byte-identical when every block is servable', () => {
    const payload = { path: 'C:/work/nb.ipynb', warnings: [] } as unknown as JsonValue;
    const result = toCallToolResult({ payload, imageBlocks: [{ data: PNG_B64, media_type: 'image/png' }] });
    expect(imageBlocksOf(result.content)).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe(JSON.stringify(payload));
  });
});

describe('[V11-10] an image failure names its cell, so dedup cannot lose attribution', () => {
  it('[V11-10] three broken images produce three messages that say WHICH cells', async () => {
    // The message used to carry only the output index, and every cell's outputs start at 0, so
    // all three cells produced the byte-identical line "failed to decode image at output 0".
    // The read path then printed it three times and the run path deduplicated it to one: the
    // first is unusable, the second discards the answer (review v11 V11-10, measured).
    const rendered = await readFull(notebookWithBrokenImagePerCell(3));
    const warnings = (rendered.payload['warnings'] ?? []) as Array<{ code: string; message: string }>;
    const failures = warnings.filter((warning) => warning.code === 'image_materialize_failed');
    expect(failures).toHaveLength(3);
    const messages = failures.map((warning) => warning.message);
    expect(new Set(messages).size, `messages were not distinct: ${JSON.stringify(messages)}`).toBe(3);
    for (const [index, message] of messages.entries()) {
      expect(message, 'the cell index is what identifies it').toContain(`cell ${String(index)}`);
      expect(message).toContain('artifact_path and image_index stay null');
    }
    // Exactly the shape the dropped-mime warning already had: `cell N (output M)`.
    expect(messages[0]).toContain('cell 0 (output 0)');
    expect(messages[2]).toContain('cell 2 (output 0)');
  });
});

describe('[V9-1] the base64 codec agrees with atob and with Buffer', () => {
  it('[V9-1] round-trips every length and rejects what atob rejects', () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (i * 37 + length) & 0xff;
      }
      const encoded = encodeBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect(isBase64Shaped(encoded)).toBe(true);
      expect([...(decodeBase64ToBytes(encoded) ?? [])]).toEqual([...bytes]);
      // Unpadded input is accepted by atob, so it must be accepted here too.
      const unpadded = encoded.replace(/=+$/, '');
      expect([...(decodeBase64ToBytes(unpadded) ?? [])]).toEqual([...bytes]);
    }
    // `atob` re-pads internally, so unpadded input is valid and a longer unbroken
    // run of input (length 1 mod 4) is not; `AB==` decodes with `atob`, so it must
    // decode here too — being stricter than the validator withholds usable images.
    for (const bad of ['a', 'AAAAA', 'QUIAB', 'iVBORw0KGgo=!', 'data:image/png;base64,AAAA', 'AAAA AAAA', '====', 'QQ=']) {
      expect(isBase64Shaped(bad)).toBe(false);
    }
    for (const ok of ['QQ==', 'QQ', 'QUI=', 'AB==', '']) {
      expect(isBase64Shaped(ok)).toBe(true);
    }
  });
});

