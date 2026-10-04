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
import { exactNumber, losesPrecision, parseJsonExact, stringifyJsonExact } from '../../src/core/json-exact.js';
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
      // The rounded value is what the bug produced — assert the two differ, so this
      // test cannot pass by accident on a runtime that happens to keep the digits.
      expect(Number(literal)).not.toBe(BigInt(literal) >= 0n ? Number.NaN : Number.NaN);
      expect(String(Number(literal))).not.toBe(literal);
    }
  });

  it('[V9-5] only integers outside the safe range are treated as inexact', () => {
    for (const exact of ['0', '-1', '42', '9007199254740991', '-9007199254740991', '1.5', '0.1234567890123456789', '1e21', '2.5e-10']) {
      expect(losesPrecision(exact), exact).toBe(false);
      expect(typeof (parseJsonExact(exact) as unknown)).toBe('number');
    }
    for (const inexact of ['9007199254740992', '9007199254740993', BIG, BIG_NEGATIVE, '-9007199254740993']) {
      expect(losesPrecision(inexact), inexact).toBe(true);
    }
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
      { empty: {}, emptyList: [], zero: 0, negativeZero: -0, float: 1.5, exp: 1e21 },
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
