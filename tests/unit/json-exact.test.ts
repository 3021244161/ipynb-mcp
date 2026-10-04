// V9-5: JSON values that JavaScript cannot hold exactly (review v9 V9-5).
//
// The failure this file pins down: `application/json` holding a large integer came
// back rounded (`18446744073709551616` -> `18446744073709552000`), `warnings: []`,
// and the run path wrote the rounded value into the user's file. Everything else
// about the read direction was already exact (v7/v8), which is exactly why the
// number domain was missed.
//
// The assertions are on the FILE BYTES and on what the model receives, not on the
// parser's internal tree: AGENTS §9's layer rule, learned the hard way in the same
// family four rounds running.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JsonValue } from '../../src/core/errors.js';
import { exactNumber, isExactNumber, losesPrecision, parseJsonExact, stringifyJsonExact } from '../../src/core/json-exact.js';
import { parseNotebook, serializeNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { renderReadResult } from '../../src/mcp/render/read.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';

const BIG = '18446744073709551616'; // 2**64
const BIG_NEGATIVE = '-9223372036854775808'; // -2**63
const UNSAFE = '9007199254740993'; // 2**53 + 1

let workspace: string;
let artifactRoot: string;
let notebookPath: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-exact-json-'));
  artifactRoot = path.join(workspace, 'artifacts');
  notebookPath = path.join(workspace, 'big.ipynb');
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/**
 * A notebook whose `application/json` output holds `literal` VERBATIM.
 *
 * Written as text on purpose: building it with `JSON.stringify` would round the
 * number before the parser ever saw it, which is the very thing under test.
 */
function notebookTextWithJsonLiteral(literal: string, mime = 'application/json'): string {
  return [
    '{',
    ' "cells": [',
    '  {',
    '   "cell_type": "code",',
    '   "execution_count": 1,',
    '   "id": "c0",',
    '   "metadata": {},',
    '   "outputs": [',
    '    {',
    '     "data": {',
    `      "${mime}": ${literal}`,
    '     },',
    '     "metadata": {},',
    '     "output_type": "display_data"',
    '    }',
    '   ],',
    '   "source": [',
    '    "x"',
    '   ]',
    '  }',
    ' ],',
    ' "metadata": {},',
    ' "nbformat": 4,',
    ' "nbformat_minor": 5',
    '}',
    '',
  ].join('\n');
}

function parseText(text: string) {
  return parseNotebook(new TextEncoder().encode(text), hasher);
}

describe('[V9-5] the parser keeps numbers JavaScript would round', () => {
  it('[V9-5] parse keeps the literal, and stringify writes it back byte-for-byte', () => {
    for (const literal of [BIG, BIG_NEGATIVE, UNSAFE]) {
      const parsed = parseJsonExact(`{"v":${literal}}`) as { v: unknown };
      // The marker, not a number: `Number(literal)` is already the wrong value.
      expect(parsed.v).toEqual(exactNumber(literal));
      expect(stringifyJsonExact(parsed)).toBe(`{"v":${literal}}`);
      // The rounded value is what the bug produced, and it is a DIFFERENT number — the
      // only thing that entitles this module to keep the literal. (This assertion used to
      // be the tautology `Number(literal) !== NaN`, which held for every input; review
      // v11 V11-4 caught that it had survived a round of "已删除" claims.)
      expect(String(Number(literal))).not.toBe(literal);
      expect(losesPrecision(literal), literal).toBe(true);
    }
  });

  it('[V10-3][V11-1] the criterion is the VALUE, with an explicit table of both sides', () => {
    // The v9 version listed only integers (which is how the DECIMAL half survived a round,
    // v10 V10-3); the v10 version asked the BYTES question and so called every ordinary
    // Python float spelling a precision loss (v11 V11-1).
    //
    // The table below is INDEPENDENT of the implementation: each entry is a claim about a
    // literal, written out rather than derived from `losesPrecision`. That is the point —
    // the v10 matrix computed its expectations by calling the function it was testing, so
    // it could not have caught a wrong criterion (review v11 V11-1, "期望自我循环").
    const valueSurvives = [
      // Exactly representable integers, including the boundary in both directions.
      '0', '-1', '42', '9007199254740991', '9007199254740992', '-9007199254740991',
      // Decimals: the double's shortest round-trip form is the same NUMBER as the literal.
      '0.1', '0.2', '0.3', '0.25', '1.5', '0.30000000000000004', '2.5e-10', '1e-7', '1e-300',
      // …and the spellings Python's own json.dumps emits, which the v11 review measured.
      '100.0', '2.0', '1e2', '1.5e3', '0.10', '1.5e-07', '2.5e-05', '1e+100', '1e308',
      // A large integer a double holds exactly: `String(Number(x))` is `5e+21`, a different
      // spelling of the same number.
      '5000000000000000000000',
      // `1E+2` is the v10 case whose expectation this round deliberately relaxes: the value
      // survives, so the spelling change is not a value loss. See D-051's v11 correction.
      '1E+2', '1e21',
    ];
    for (const literal of valueSurvives) {
      expect(losesPrecision(literal), literal).toBe(false);
    }

    const valueChanges = [
      // Precision: the double denotes a DIFFERENT number than the literal.
      '9007199254740993',
      '-9007199254740993',
      BIG,
      BIG_NEGATIVE,
      '123456789012345678901234567890',
      '0.1234567890123456789',
      '0.1234567890123456789012345',
      '1.0000000000000001',
      '3.141592653589793238462643383279',
      '0.10000000000000001',
      // Out of range for a double (the response delivers null; the digits are in the file).
      '1e400',
      '-1e400',
      '1e309',
      // The value is exactly zero, but the sign is a fact the JSON channel cannot carry.
      '-0',
      // 55 digits that happen to BE `Number('0.1')`. Reported, not silently shortened: the
      // digits are the caller's, and the v11 review's own criterion — normalize the
      // formatting, then compare with the double's shortest form — says the same. What the
      // message must NOT do is call the VALUE imprecise: `0.1` is exactly what a client
      // reads, and the digits are in the file (see the wording case in
      // `json-number-forms.test.ts`).
      '0.1000000000000000055511151231257827021181583404541015625',
    ];
    for (const literal of valueChanges) {
      expect(losesPrecision(literal), literal).toBe(true);
    }

    // The parse side follows the same table: a surviving value is a plain number, and the
    // ones that do not survive are markers.
    for (const literal of valueSurvives) {
      expect(typeof (parseJsonExact(literal) as unknown), literal).toBe('number');
    }
    for (const literal of valueChanges) {
      expect(isExactNumber(parseJsonExact(literal)), literal).toBe(true);
    }
  });

  it('[V11-2] a clone invalidates the marker — a KNOWN LIMIT, measured here', () => {
    // The v10 comment claimed the opposite ("extensibility IS preserved by structuredClone,
    // so the marker survives the clone"), and a comment that blesses an unsafe refactor is
    // worse than no comment: the next person reads it and concludes a snapshot-then-write
    // path is fine. This case exists so the limitation cannot be re-forgotten, and so the
    // day someone makes the marker clone-safe, this test is what tells them.
    const marker = exactNumber(BIG);
    expect(isExactNumber(marker), 'the original is a marker').toBe(true);
    expect(Object.isExtensible(marker)).toBe(false);

    const cloned = structuredClone(marker);
    expect(isExactNumber(cloned), 'a clone is NOT a marker').toBe(false);
    expect(Object.isExtensible(cloned), 'structuredClone drops the frozen state').toBe(true);
    // The consequence, in bytes: the marker OBJECT would reach the user's file.
    expect(stringifyJsonExact({ v: cloned })).toBe(`{"v":${JSON.stringify(marker)}}`);
    expect(stringifyJsonExact({ v: marker })).toBe(`{"v":${BIG}}`);

    // Which is why the invariant the serializer depends on is about the ORIGINAL tree: the
    // document that gets written is the one `parseNotebook` produced, and that tree keeps
    // its markers. Asserted end to end in the same file (`[V9-5]` cases below) and in
    // `v10-regressions.test.ts` for the edit path, which is the one that clones.
  });

  it('[V9-5] the serializer matches JSON.stringify for everything it does not mark', () => {
    // The serializer is hand-written (the built-in cannot see markers nested inside
    // arrays and objects), so "identical to JSON.stringify" is a claim that has to
    // be tested: a formatting difference would rewrite the whole file on every
    // write, which SPEC §5.5.7 tolerates in theory and nobody wants in practice.
    const trees: unknown[] = [
      {},
      [],
      { a: 1, b: 'x', c: true, d: null },
      { nested: { list: [1, 2, { deep: ['\n', 'quote"', 'back\\slash', 'tab\t'] }] } },
      { unicode: 'héllo — 中文 😀', escapes: '\u0007\u001f' },
      { empty: {}, emptyList: [], zero: 0, float: 1.5, exp: 1e21 },
      [{ a: undefined, b: 1 }, [undefined, 2]],
      { a: [null, false] },
    ];
    for (const tree of trees) {
      expect(stringifyJsonExact(tree), JSON.stringify(tree)).toBe(JSON.stringify(tree));
      expect(stringifyJsonExact(tree, 1), `${JSON.stringify(tree)} (indent 1)`).toBe(JSON.stringify(tree, null, 1));
      // Not `indent 0`: that is COMPACT in the built-in, not "pretty with no
      // padding", and the two disagree there (`{"a":1}` vs `{\n"a": 1\n}`). The
      // compact form is `indent === undefined`, which is asserted above.
      expect(stringifyJsonExact(tree, '\t')).toBe(JSON.stringify(tree, null, '\t'));
      expect(stringifyJsonExact(tree, 2)).toBe(JSON.stringify(tree, null, 2));
    }
    // Only a marking changes the output, and it changes exactly one token.
    const marked = { big: exactNumber(BIG), small: 1 };
    expect(stringifyJsonExact(marked, 1)).toBe('{\n "big": 18446744073709551616,\n "small": 1\n}');
    // The ONE documented divergence from the built-in: `JSON.stringify(-0)` writes `0`,
    // while this serializer writes the sign back. It is the same class of fix as the
    // markers — the file's bytes must survive — and it is pinned so nobody "simplifies"
    // it away. `-0` is not in the trees above for exactly this reason.
    expect(JSON.stringify({ z: -0 })).toBe('{"z":0}');
    expect(stringifyJsonExact({ z: -0 })).toBe('{"z":-0}');
    expect(Object.is(JSON.parse('{"z":-0}').z, -0)).toBe(true);
  });

  it('[V9-5] a notebook holding a big json integer is written back with the same digits', async () => {
    const text = notebookTextWithJsonLiteral(BIG);
    const notebook = parseText(text);
    const serialized = serializeNotebook(notebook);
    expect(serialized).toContain(BIG);
    expect(serialized).not.toContain('18446744073709552000');
    // The whole file, not just the one token: no other line moved either.
    expect(serialized).toBe(text);
    // …and the authority agrees it is still valid nbformat.
    await writeFile(notebookPath, serialized, 'utf8');
    const reread = await readFile(notebookPath, 'utf8');
    expect(reread).toBe(serialized);
  });

  it('[V9-5] the file keeps the digits even when the write goes through an edit', async () => {
    // An edit rewrites the whole document; if the parser had rounded, this write
    // would persist the rounded value — the "disk loses the data permanently" half
    // of the finding.
    const notebook = parseText(notebookTextWithJsonLiteral(BIG));
    (notebook.cells[0] as { source: unknown }).source = ['y'];
    const serialized = serializeNotebook(notebook);
    expect(serialized).toContain(`"application/json": ${BIG}`);
    expect(serialized).not.toContain('18446744073709552000');
    expect(serialized).toContain('"y"');
  });

  it('[V9-5] works for every +json mime, not just application/json', () => {
    for (const mime of ['application/json', 'application/x+json', 'application/vnd.custom+json', 'application/x/y+json']) {
      const notebook = parseText(notebookTextWithJsonLiteral(BIG, mime));
      expect(serializeNotebook(notebook), mime).toContain(`"${mime}": ${BIG}`);
    }
  });
});

describe('[V9-5] the model is told when a value cannot be represented exactly', () => {
  async function readFull(text: string): Promise<{ payload: Record<string, unknown>; content: ReturnType<typeof toCallToolResult>['content'] }> {
    const notebook = parseText(text);
    const rendered = await renderReadResult({
      notebook,
      path: notebookPath,
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
    const result = toCallToolResult({ payload: rendered.payload as JsonValue, imageBlocks: rendered.imageBlocks });
    return { payload: rendered.payload, content: result.content };
  }

  it('[V9-5] the read reports the loss and still carries the exact digits', async () => {
    const { payload } = await readFull(notebookTextWithJsonLiteral(BIG));
    const cells = payload['cells'] as Array<Record<string, unknown>>;
    const outputs = cells[0]!['outputs'] as Array<Record<string, unknown>>;
    const item = outputs[0]!;
    expect(item['kind']).toBe('json');
    const itemWarnings = item['warnings'] as Array<{ code: string; message: string }>;
    expect(itemWarnings).toHaveLength(1);
    expect(itemWarnings[0]!.code).toBe('output_truncated');
    expect(itemWarnings[0]!.message).toContain(BIG);
    // The call-level list a client reads carries it too — without it the model gets
    // a rounded number and no reason to doubt it.
    const callWarnings = payload['warnings'] as Array<{ code: string; message: string }>;
    expect(callWarnings.map((warning) => warning.message)).toContain(itemWarnings[0]!.message);
  });

  it('[V9-5] an exactly representable json value produces no warning at all', async () => {
    const { payload } = await readFull(notebookTextWithJsonLiteral('1234'));
    const cells = payload['cells'] as Array<Record<string, unknown>>;
    const outputs = cells[0]!['outputs'] as Array<Record<string, unknown>>;
    expect(outputs[0]).toMatchObject({ kind: 'json', value: 1234, warnings: [] });
    expect(payload['warnings']).toEqual([]);
  });
});
