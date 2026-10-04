// The NUMBER-FORMS matrix (review v10 V10-1/V10-3, AGENTS §9's fifth rule).
//
// `json-exact.ts` exists so a number in a notebook survives the trip through a JS
// double. Two rounds in a row it protected only the shape the author was thinking
// about — v9 covered integers and left decimals (V10-3) — and the write-back
// re-serializes the WHOLE document, so the damage lands in cells the caller never
// asked to change.
//
// So the grid is explicit: every FORM of number × every POSITION it can appear in, and
// three claims per cell:
//   ① the file keeps the literal (byte level — the one that touches user data);
//   ② the model is told, exactly once per distinct literal, with the digits in the
//      message, and never sees an internal marker;
//   ③ a value that survives the JS round trip stays a plain number, so the common case
//      is not turned into a warning (the over-correction would be as bad as the bug).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isExactNumber, losesPrecision, parseJsonExact, stringifyJsonExact } from '../../src/core/json-exact.js';
import { mapRawOutputs, rawOutputsOfCell } from '../../src/core/outputs.js';
import { parseNotebook, serializeNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';

/** Literals whose FORM is the point, and whether a JS number can carry them. */
const FORMS = [
  { literal: '0', exact: true, why: 'zero' },
  { literal: '-1', exact: true, why: 'small negative integer' },
  { literal: '9007199254740991', exact: true, why: '2^53 - 1, the last safe integer' },
  { literal: '9007199254740992', exact: true, why: '2^53, exactly representable' },
  { literal: '9007199254740993', exact: false, why: '2^53 + 1, the first unrepresentable integer' },
  { literal: '18446744073709551616', exact: false, why: '2^64' },
  { literal: '-9223372036854775808', exact: false, why: '-2^63' },
  { literal: '123456789012345678901234567890', exact: false, why: 'a long integer' },
  { literal: '0.1', exact: true, why: 'a decimal that round-trips' },
  { literal: '1.5', exact: true, why: 'a plain fraction' },
  { literal: '0.1234567890123456789012345', exact: false, why: 'more digits than a double holds' },
  { literal: '1.0000000000000001', exact: false, why: 'rounds down to 1' },
  { literal: '3.141592653589793238462643383279', exact: false, why: 'pi to 30 places' },
  { literal: '0.30000000000000004', exact: true, why: "the double's own shortest form" },
  { literal: '1e21', exact: false, why: 'JS spells it 1e+21' },
  { literal: '1E+2', exact: false, why: 'JS spells it 100' },
  { literal: '2.5e-10', exact: true, why: 'a small exponent that round-trips' },
  { literal: '1e400', exact: false, why: 'overflows a double entirely' },
  { literal: '-0', exact: false, why: 'negative zero, where String() drops the sign' },
  { literal: '0.0', exact: false, why: 'trailing zero, which String() removes' },
] as const;

/** Where the number sits inside the json value. */
const POSITIONS = [
  { name: 'at the top level', build: (literal: string): string => literal },
  { name: 'in an object at depth 1', build: (literal: string): string => `{"n":${literal}}` },
  { name: 'in an object at depth 2', build: (literal: string): string => `{"a":{"b":${literal}}}` },
  { name: 'in an array', build: (literal: string): string => `[${literal}]` },
  { name: 'in an array inside an object', build: (literal: string): string => `{"list":[${literal}]}` },
  {
    name: 'in an object inside an array inside an object',
    build: (literal: string): string => `{"wrap":[{"deep":${literal}}]}`,
  },
  {
    name: 'beside another inexact number',
    build: (literal: string): string => `{"first":${literal},"second":18446744073709551616}`,
  },
  {
    name: 'twice, at two depths',
    build: (literal: string): string => `{"top":${literal},"nested":{"again":${literal}}}`,
  },
] as const;

function options() {
  return { inlineTextChars: 20000, maxImageBytes: 20 * 1024 * 1024, hasher };
}

/** A string that cannot collide with a probe: JSON text has no private-use characters. */
const VALUE_SLOT = '\uE000ipynb-mcp-json-value\uE000';

/**
 * A notebook whose first cell carries `jsonText` as its `application/json` value.
 *
 * Built by serializing the CONTAINER with this project's own writer, then splicing
 * `jsonText` in at a placeholder. The splice is through a unique placeholder rather than
 * an escape, because the point is that these bytes reach the parser untouched: a
 * `JSON.stringify` of the fixture would round the numbers before the parser saw them.
 *
 * The value is inserted EXACTLY as passed — compact text stays compact — so this helper
 * does not hide normalization. The cases below therefore run the serializer TWICE and
 * compare: whatever a first write produces, a second write must produce the same bytes.
 * That is the property that matters for user data (a document is written, then written
 * again after the next edit), and it is stronger than comparing against a hand-written
 * fixture.
 */
function notebookText(jsonText: string, extraCellSource?: string): string {
  const cells: unknown[] = [
    {
      cell_type: 'code',
      execution_count: 1,
      id: 'c0',
      metadata: {},
      outputs: [{ data: { 'application/json': VALUE_SLOT }, metadata: {}, output_type: 'display_data' }],
      source: ['x'],
    },
  ];
  if (extraCellSource !== undefined) {
    cells.push({
      cell_type: 'code',
      execution_count: null,
      id: 'c1',
      metadata: {},
      outputs: [],
      source: [extraCellSource],
    });
  }
  const serialized = stringifyJsonExact({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, 1);
  const body = jsonText
    .split('\n')
    .map((line, index) => (index === 0 ? line : line.trimStart()))
    .join('\n');
  return `${serialized.replace(`"${VALUE_SLOT}"`, body)}\n`;
}

/** Parse and write `text` once, as a real edit does. */
function writeOnce(text: string): string {
  return serializeNotebook(parseNotebook(new TextEncoder().encode(text), hasher));
}

/**
 * The literal text of the `application/json` value in a serialized notebook.
 *
 * Sliced out of the document rather than re-serialized from the parsed tree: the claim
 * under test is about the BYTES, and re-serializing would test the writer against itself.
 */
function storedJsonValueText(text: string): string {
  const marker = '"application/json": ';
  const start = text.indexOf(marker);
  if (start < 0) {
    throw new Error('no application/json value in the document');
  }
  const from = start + marker.length;
  // Walk to the end of the value: a scalar ends at the first comma or newline, a
  // container ends at its matching bracket.
  const first = text[from]!;
  if (first !== '{' && first !== '[') {
    const stop = text.slice(from).search(/[,\n]/);
    return stop < 0 ? text.slice(from) : text.slice(from, from + stop);
  }
  const open = first;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(from, index + 1);
      }
    }
  }
  throw new Error('unterminated application/json value');
}

/** The distinct inexact literals inside a JSON text, in order of first appearance. */
function inexactLiteralsIn(jsonText: string): string[] {
  const found: string[] = [];
  for (const match of jsonText.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const literal = match[0];
    if (losesPrecision(literal) && !found.includes(literal)) {
      found.push(literal);
    }
  }
  return found;
}

/** The literals a set of warning messages names, in order. */
function warnedLiterals(messages: readonly string[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    const match = /json value (-?\S+) was not representable exactly/.exec(message);
    if (match !== null) {
      found.push(match[1]!);
    }
  }
  return found;
}

/**
 * Structural equality that also distinguishes `-0` from `0`.
 *
 * `toEqual` is loose about the sign of zero and `toStrictEqual` refuses to compare any
 * object containing a key named `constructor` (vitest 3.2.7 reports "no visual
 * difference"), so the numbers are compared recursively by hand. This is the assertion
 * that catches "the value was rounded", and it is deliberately about VALUES — the bytes
 * claim is a separate assertion, because a value can survive while its spelling does not.
 */
function expectSameValue(actual: unknown, expected: unknown, where = '$'): void {
  expect(actual, where).toEqual(expected);
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Object.is(actual, expected), `${where}: ${String(actual)} vs ${String(expected)}`).toBe(true);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual, where).toHaveLength(expected.length);
    for (const [index, entry] of expected.entries()) {
      expectSameValue(actual[index], entry, `${where}[${String(index)}]`);
    }
    return;
  }
  if (typeof expected === 'object' && expected !== null && typeof actual === 'object' && actual !== null) {
    for (const key of Object.keys(expected)) {
      expectSameValue(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${where}.${key}`,
      );
    }
  }
}

/** The one json item a mapped cell produces, as the model receives it. */
function jsonItem(jsonText: string): { kind: 'json'; value: unknown; warnings: Array<{ code: string; message: string }> } {
  const notebook = parseNotebook(new TextEncoder().encode(notebookText(jsonText)), hasher);
  const mapped = mapRawOutputs(rawOutputsOfCell(notebook.cells[0]!), options());
  const item = mapped.items[0];
  if (item === undefined || item.kind !== 'json') {
    throw new Error(`expected a json item, got ${JSON.stringify(item)}`);
  }
  return item;
}

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v10-'));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('[V10-3] every number literal the file holds survives the write-back', () => {
  for (const position of POSITIONS) {
    it(`[V10-3] ${position.name}: the file keeps each literal byte for byte`, () => {
      for (const form of FORMS) {
        const text = notebookText(position.build(form.literal));
        const written = writeOnce(text);
        // Idempotent: a second write produces the same bytes. Whatever normalization
        // the first write performs (indentation of a nested container), the second
        // write may not change anything — that is what "the file does not move under
        // an unrelated edit" means in practice.
        expect(writeOnce(written), `${form.literal} (${form.why}) — ${position.name}`).toBe(written);
        // And the literal itself is in the bytes, exactly as spelled.
        expect(written, `${form.literal}`).toContain(form.literal);
        // …and the VALUE that came back is the value that went in, compared with
        // `Object.is` semantics on every number. That single assertion subsumes "not
        // rounded": a rounding would show up as a different number, and it works for
        // `1.0000000000000001` (where "does the text contain `1`" cannot).
        expectSameValue(
          parseJsonExact(storedJsonValueText(written)),
          parseJsonExact(position.build(form.literal)),
          `${form.literal} (${form.why}) — ${position.name}`,
        );
      }
    });
  }

  it('[V10-3] editing a DIFFERENT cell leaves the value exactly as it was', async () => {
    // The review's reproduction, and the reason this was a 🔴: the write-back
    // re-serializes the whole document, so a decimal in cell 0 was rewritten by an edit
    // that only named cell 1. Every form is checked, because "which forms survive" is
    // the question the matrix exists to answer.
    for (const form of FORMS) {
      const original = notebookText(form.literal, 'y = 1');
      const target = path.join(workspace, `edit-${form.literal.replace(/[^0-9a-zA-Z+-]/g, '_')}.ipynb`);
      await writeFile(target, original, 'utf8');

      // What an edit of the OTHER cell does: mutate cell 1, then serialize everything —
      // the same call `writeNotebookFile` makes.
      const notebook = parseNotebook(new TextEncoder().encode(await readFile(target, 'utf8')), hasher);
      (notebook.cells[1] as { source: unknown }).source = ['y = 2'];
      const written = serializeNotebook(notebook);

      expect(written, `${form.literal} (${form.why})`).toContain(`"application/json": ${form.literal}\n`);
      expect(written, `${form.literal} (${form.why})`).toContain('"y = 2"');
      await writeFile(target, written, 'utf8');
    }
  });

  it('[V10-3] the run path keeps them too, through the sidecar protocol parser', () => {
    // The execution path does not read the document for this: the value arrives in a
    // sidecar message and is parsed by the SAME parser. Round-tripping a message is
    // what proves the protocol layer cannot round either.
    for (const form of FORMS) {
      const message = `{"id":"1","ok":true,"result":{"rawOutputs":[{"outputType":"display_data","data":{"application/json":${form.literal}}}]}}`;
      const parsed = parseJsonExact(message) as {
        result: { rawOutputs: Array<{ data: { 'application/json': unknown } }> };
      };
      const value = parsed.result.rawOutputs[0]!.data['application/json'];
      expect(stringifyJsonExact({ v: value }), `${form.literal} (${form.why})`).toBe(`{"v":${form.literal}}`);
    }
  });

  it('[V10-3] a value that survives as a double stays a plain number', () => {
    // The over-correction to avoid: marking everything would put a marker (and a
    // warning) on `0.1`, and a warning that appears for correct values is noise the
    // model learns to ignore.
    for (const form of FORMS.filter((entry) => entry.exact)) {
      const parsed = parseJsonExact(form.literal);
      expect(typeof parsed, `${form.literal} (${form.why})`).toBe('number');
      expect(isExactNumber(parsed)).toBe(false);
      expect(String(parsed)).toBe(form.literal);
    }
  });
});

describe('[V10-1] a number reaches the model as a number, with the digits in a warning', () => {
  for (const position of POSITIONS) {
    it(`[V10-1] ${position.name}: no marker leaks and every inexact literal is reported`, () => {
      for (const form of FORMS) {
        const item = jsonItem(position.build(form.literal));
        // ① No internal marker at any depth — this is what v10-1 found leaking, and it
        // is checked in the serialized form because that is what the model reads.
        expect(stringifyJsonExact(item), `${form.literal} ${position.name}`).not.toContain('__ipynb_exact_number__');
        // ② The value is a number, never a structure we invented. (Even `1e400`, whose
        // double is Infinity: the JSON channel cannot carry that either, and the
        // warning says so — see the case below.)
        expect(isExactNumber(item.value), `${form.literal} ${position.name}`).toBe(false);
        expect(['number', 'object'], `${form.literal} ${position.name}`).toContain(typeof item.value);
        // ③ Every distinct inexact literal is named, exactly once each — derived from
        // the text under test rather than from the form's own flag, so a position that
        // embeds a second number (there is one) cannot make the expectation wrong.
        const expected = inexactLiteralsIn(position.build(form.literal));
        expect(warnedLiterals(item.warnings.map((warning) => warning.message)), `${form.literal} ${position.name}`)
          .toEqual(expected);
        // ④ Warning codes stay inside SPEC §7's closed table.
        for (const warning of item.warnings) {
          expect(warning.code, `${form.literal}`).toBe('output_truncated');
        }
      }
    });
  }

  it('[V10-1] the warning names the exact digits and the value a client will read', () => {
    const item = jsonItem('{"big":18446744073709551616}');
    expect(item.warnings).toHaveLength(1);
    const message = item.warnings[0]!.message;
    expect(message).toContain('18446744073709551616');
    expect(message).toContain('18446744073709552000');
    expect(message).toContain('not representable exactly');
  });

  it('[V10-1] one warning per distinct literal, not one per occurrence', () => {
    const item = jsonItem('{"a":18446744073709551616,"b":[18446744073709551616]}');
    expect(item.warnings).toHaveLength(1);
  });

  it('[V10-1] two distinct inexact literals produce two warnings', () => {
    const item = jsonItem('{"a":18446744073709551616,"b":0.1234567890123456789012345}');
    expect(item.warnings).toHaveLength(2);
    const joined = item.warnings.map((warning) => warning.message).join('\n');
    expect(joined).toContain('18446744073709551616');
    expect(joined).toContain('0.1234567890123456789012345');
  });

  it('[V10-1] a deeply nested value keeps its shape and its siblings', () => {
    const item = jsonItem('{"a":{"b":[1,{"c":18446744073709551616},3]},"d":"text"}');
    expect(item.value).toEqual({ a: { b: [1, { c: 18446744073709552000 }, 3] }, d: 'text' });
    expect(Object.keys(item.value as object)).toEqual(['a', 'd']);
    expect(Object.keys((item.value as { a: { b: Array<Record<string, unknown>> } }).a.b[1]!)).toEqual(['c']);
  });

  it('[V10-1] keys named like the marker are still the user\'s data', () => {
    // A file may legally contain this key. The parser stores it like any other key, the
    // projection must hand it back unchanged, and the write-back must keep the object.
    const item = jsonItem('{"__ipynb_exact_number__":"42"}');
    expect(item.value).toEqual({ __ipynb_exact_number__: '42' });
    expect(item.warnings).toEqual([]);
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookText('{"__ipynb_exact_number__":"42"}')),
      hasher,
    );
    expect(serializeNotebook(notebook)).toContain('"__ipynb_exact_number__": "42"');
  });
});
