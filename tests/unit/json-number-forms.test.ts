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

import {
  isExactNumber,
  losesPrecision,
  normalizedSpelling,
  parseJsonExact,
  stringifyJsonExact,
} from '../../src/core/json-exact.js';
import { mapRawOutputs, rawOutputsOfCell } from '../../src/core/outputs.js';
import { parseNotebook, serializeNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';

/**
 * Every literal whose FORM is the point, with an EXPLICIT expectation.
 *
 * `warned` is written here rather than computed from `losesPrecision`, and that is the
 * v11 correction (V11-1): the first version of this table derived its expectations by
 * calling the function under test, so a wrong criterion made the test agree with itself —
 * it reported 24 green cases while telling every notebook with a float that its value
 * "was not representable exactly".
 *
 * `warned: true` ⇒ the literal must reach the file byte-for-byte and the model must be
 * told, with the digits in the message. `warned: false` ⇒ the double carries the value
 * and the spelling is one of the forms a JSON writer normalizes away, so the file may
 * hold the number's own spelling and the response must be silent.
 */
const FORMS = [
  { literal: '0', warned: false, why: 'zero' },
  { literal: '-1', warned: false, why: 'small negative integer' },
  { literal: '9007199254740991', warned: false, why: '2^53 - 1, the last safe integer' },
  { literal: '9007199254740992', warned: false, why: '2^53, exactly representable' },
  { literal: '9007199254740993', warned: true, why: '2^53 + 1, the first unrepresentable integer' },
  { literal: '18446744073709551616', warned: true, why: '2^64 is a double, but not those digits' },
  { literal: '-9223372036854775808', warned: true, why: '-2^63' },
  { literal: '123456789012345678901234567890', warned: true, why: 'a long integer' },
  { literal: '0.1', warned: false, why: 'a decimal that round-trips' },
  { literal: '1.5', warned: false, why: 'a plain fraction' },
  { literal: '100.0', warned: false, why: "Python's json.dumps spells 100 this way" },
  { literal: '1e2', warned: false, why: 'exponent notation for 100' },
  { literal: '1.5e3', warned: false, why: 'exponent notation for 1500' },
  { literal: '0.10', warned: false, why: 'a trailing zero' },
  { literal: '1e-07', warned: false, why: "Python's json.dumps spells 1e-7 this way" },
  { literal: '2.5e-05', warned: false, why: "Python's json.dumps spells 2.5e-5 this way" },
  { literal: '0.1234567890123456789012345', warned: true, why: 'more digits than a double holds' },
  { literal: '1.0000000000000001', warned: true, why: 'rounds down to 1' },
  { literal: '3.141592653589793238462643383279', warned: true, why: 'pi to 30 places' },
  { literal: '0.30000000000000004', warned: false, why: "the double's own shortest form" },
  { literal: '1e21', warned: false, why: 'JS spells it 1e+21, which is the same digits' },
  { literal: '1E+2', warned: false, why: 'JS spells it 100, which is the same digits' },
  { literal: '2.5e-10', warned: false, why: 'a small exponent that round-trips' },
  { literal: '1e400', warned: true, why: 'overflows a double entirely' },
  // UNDERFLOW — the mirror of the line above, and the v12 blocker (V12-1). A nonzero mantissa
  // whose double is zero is a value change, so it is protected and reported. These rows exist
  // in BOTH directions: `1e-320` is a subnormal and survives, `0e-400` denotes zero and merely
  // changes spelling, and neither may be swept up by the underflow rule.
  { literal: '1e-400', warned: true, why: 'underflows to zero' },
  { literal: '1e-324', warned: true, why: 'underflows to zero (just below the subnormal range)' },
  { literal: '2e-400', warned: true, why: 'underflows to zero' },
  { literal: '-1e-400', warned: true, why: 'underflows to negative zero' },
  { literal: '1e-320', warned: false, why: 'a SUBNORMAL: small, but a double holds it' },
  { literal: '5e-324', warned: false, why: 'the smallest positive subnormal' },
  { literal: '0e-5', warned: false, why: 'an exponent with nonzero digits but a zero mantissa' },
  { literal: '-0', warned: true, why: 'negative zero: the sign is a fact the response cannot carry' },
  { literal: '0.0', warned: false, why: 'trailing zero on a zero' },
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

/**
 * The literals that MUST be named in the warnings for a json text, in order.
 *
 * A written-down answer rather than a call to `losesPrecision`: the previous version
 * scanned the text with the function it was testing, so the expectation could not
 * disagree with the implementation (v11 V11-1, "期望自我循环"). The match is anchored on
 * the literal forms this file uses, and `18446744073709551616` appears in one POSITION.
 */
function expectedWarnedLiterals(jsonText: string): string[] {
  const expected = FORMS.filter((form) => form.warned && containsNumber(jsonText, form.literal)).map(
    (form) => form.literal,
  );
  // One POSITION embeds a second number, and it is deliberately the same literal the
  // "beside another inexact number" case is built around.
  const embedded = '18446744073709551616';
  if (containsNumber(jsonText, embedded) && !expected.includes(embedded)) {
    expected.push(embedded);
  }
  // First appearance order, which is the order the projection walks the value in.
  return expected.sort((left, right) => jsonText.indexOf(left) - jsonText.indexOf(right));
}

/**
 * Is `literal` a NUMBER TOKEN in `jsonText`, rather than a substring of a longer one?
 *
 * The naive `includes` is what made the first version of this table wrong: `1e-07`
 * contains `-0`, so the expectation demanded a warning for a literal that is not in the
 * text at all. The boundary check is what a reader of JSON would do.
 */
function containsNumber(jsonText: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\d.eE+-])${escaped}(?![\\d.])`).test(jsonText);
}

/**
 * The literals a set of warning messages names, in order.
 *
 * Three message shapes reach here and each is matched explicitly, because the assertion's
 * job is to notice a MISSING warning — an over-specific regex that quietly matches nothing
 * would report "no warnings" on a response full of them (the v11 round caught the
 * neighbouring version of this mistake in the sentence it pinned, V11-12①).
 */
function warnedLiterals(messages: readonly string[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    const match =
      /json value (\S+) was not representable exactly/.exec(message) ??
      /json value (\S+) is outside the range/.exec(message) ??
      /json value (\S+) is negative zero/.exec(message) ??
      /json value (\S+) underflows to zero/.exec(message);
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
        // ① A literal the double cannot carry is in the bytes exactly as spelled.
        // ② A literal the double carries loses only its formatting, so the file holds the
        // number's own spelling — and the VALUE is what must not move. The expectation
        // comes from the table, never from `losesPrecision` (v11 V11-1).
        if (form.warned) {
          expect(written, `${form.literal}`).toContain(form.literal);
        }
        // …and the VALUE that came back is the value that went in, compared with
        // `Object.is` semantics on every number. That single assertion subsumes "not
        // rounded": a rounding would show up as a different number, and it works for
        // `1.0000000000000001` (where "does the text contain `1`" cannot).
        //
        // The reference is the FIRST WRITE's tree, not the hand-built fixture: `jsonValueOf`
        // projects a protected literal to the plain number a client reads, so comparing
        // against the fixture's text would compare a marker against a number.
        expectSameValue(
          parseJsonExact(storedJsonValueText(written)),
          parseJsonExact(storedJsonValueText(text)),
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

      // The cell the edit did not name is untouched in the way this form allows: its
      // literal survives verbatim where the value needed protecting, and its VALUE is
      // preserved either way. Both halves are asserted, so "we normalized it away" can
      // never hide a rewritten number.
      if (form.warned) {
        expect(written, `${form.literal} (${form.why})`).toContain(`"application/json": ${form.literal}\n`);
      } else {
        expectSameValue(
          parseJsonExact(storedJsonValueText(written)),
          parseJsonExact(form.literal),
          `${form.literal} (${form.why})`,
        );
      }
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
      if (form.warned) {
        expect(stringifyJsonExact({ v: value }), `${form.literal} (${form.why})`).toBe(`{"v":${form.literal}}`);
      } else {
        // The protocol parser agrees with the document parser: a value the double carries
        // comes back as a number, not as an object shaped like our marker.
        expect(isExactNumber(value), `${form.literal} (${form.why})`).toBe(false);
        expectSameValue(value, Number(form.literal), `${form.literal} (${form.why})`);
      }
    }
  });

  it('[V10-3][V11-1][V12-1] a value that survives as a double stays a plain number', () => {
    // The over-correction to avoid: marking everything would put a marker (and a warning) on
    // `0.1`, and a warning that appears for correct values is noise the model learns to ignore.
    //
    // THE ASSERTION HERE USED TO BE CO-EXTENSIVE WITH THE CODE IT GUARDS, which is why the
    // v12 regression (`1e-400` → `0`, silently) could not have been caught by adding a row to
    // this table: `String(parseJsonExact('1e-400'))` and `String(Number('1e-400'))` are BOTH
    // `'0'`, so the check agreed with the bug (review v12 V12-1, "守卫与被测判据同构").
    //
    // What each form must satisfy now is written independently of the implementation:
    //   - the value the model receives is the double the writer would produce for it;
    //   - the FILE holds that same double's own spelling (`String(Number(literal))`), so an
    //     underflow cannot hide behind a comparison of two zeroes.
    // The file half is asserted below, against the bytes.
    for (const form of FORMS.filter((entry) => !entry.warned)) {
      const parsed = parseJsonExact(form.literal);
      expect(typeof parsed, `${form.literal} (${form.why})`).toBe('number');
      expect(isExactNumber(parsed)).toBe(false);
      expect(String(parsed)).toBe(String(Number(form.literal)));
      const written = writeOnce(notebookText(form.literal));
      expect(storedJsonValueText(written), `${form.literal} (${form.why})`).toBe(
        String(Number(form.literal)),
      );
    }
  });

  it('[V12-1] a literal that underflows to zero keeps its digits and says so', () => {
    // The v12 blocker, as a property rather than as four rows: a literal whose MANTISSA is
    // nonzero and whose double is zero denotes a number the double cannot hold — so it must be
    // preserved on disk and reported, exactly like overflow (`1e400` → null + warning). The
    // v11 early return (`value === 0 → isNegativeZero`) called these "no information lost" and
    // replaced them with `0` on the next write, and it reported `-1e-400` as "negative zero …
    // the value is exact", two false statements in one sentence.
    const underflows = ['1e-400', '1e-324', '1e-330', '2e-400', '-1e-400', '-1e-330', '-2e-400'];
    for (const literal of underflows) {
      expect(losesPrecision(literal), `${literal} must be protected`).toBe(true);
      const written = writeOnce(notebookText(literal));
      // ① the file keeps the literal, byte for byte — the assertion the old table could not make
      expect(storedJsonValueText(written), literal).toBe(literal);
      // ② the model is told, and the sentence describes underflow rather than negative zero
      const item = jsonItem(literal);
      expect(item.warnings, literal).toHaveLength(1);
      expect(item.warnings[0]!.message, literal).toContain('underflows to zero');
      expect(item.warnings[0]!.message, literal).not.toContain('negative zero');
      // ③ the value the model receives is the zero a client would read, not a marker. `-1e-400`
      // underflows to NEGATIVE zero, and the response channel prints that as `0` — the sign is
      // gone (the same loss the `-0` case reports) but it is not why this case exists: the whole
      // magnitude is gone, which is what the sentence says.
      expect(Object.is(item.value, 0) || Object.is(item.value, -0), `${literal} → ${String(item.value)}`).toBe(true);
    }
    // The same literals with a zero MANTISSA are NOT underflows: they denote zero and only
    // change spelling. `0e-400` in particular must not be caught by a check that looks for a
    // nonzero digit anywhere in the literal — its EXPONENT has four of them.
    for (const zero of ['0', '0.0', '0e0', '0e-5', '0.0e-400', '0.00e10']) {
      expect(losesPrecision(zero), `${zero} denotes zero`).toBe(false);
      expect(storedJsonValueText(writeOnce(notebookText(zero))), zero).toBe(String(Number(zero)));
    }
    // …and the NEGATIVE zero family stays what it always was: exactly zero, sign not carried, so
    // its own sentence and its own bytes. `-0.0` belongs here rather than in the list above —
    // "denotes zero" is true of it and is not the question; the sign is.
    for (const negativeZero of ['-0', '-0.0', '-0e0', '-0.0e-400']) {
      expect(losesPrecision(negativeZero), negativeZero).toBe(true);
      expect(storedJsonValueText(writeOnce(notebookText(negativeZero))), negativeZero).toBe(negativeZero);
      const message = jsonItem(negativeZero).warnings[0]!.message;
      expect(message, negativeZero).toContain('negative zero');
      expect(message, negativeZero).not.toContain('underflows');
    }
  });
});

describe('[V11-1] the normalizer itself, against a written table', () => {
  // The value rule is `normalizedSpelling(literal) === String(Number(literal))`, and the
  // normalizer is the part with the arithmetic in it: the first three versions each got a
  // different term wrong (`100.0` → `0.1` when the trailing-zero shift was missing, every
  // value → `0` when the trailing regex was `0*$`). So its OUTPUT is pinned against a table
  // written by hand, independently of the double and of the code under it.
  const NORMALIZED: Array<[string, string]> = [
    ['0', '0'],
    ['0.0', '0'],
    ['-0', '0'],
    ['42', '42'],
    ['-1', '-1'],
    ['9007199254740992', '9007199254740992'],
    ['18446744073709551616', '18446744073709551616'],
    ['123456789012345678901234567890', '1.2345678901234567890123456789e+29'],
    ['0.1', '0.1'],
    ['0.2', '0.2'],
    ['0.25', '0.25'],
    ['1.5', '1.5'],
    ['0.10', '0.1'],
    ['100.0', '100'],
    ['2.0', '2'],
    ['10.0', '10'],
    ['1234.5', '1234.5'],
    ['0.001', '0.001'],
    ['1e2', '100'],
    ['1E+2', '100'],
    ['1.5e3', '1500'],
    ['1e6', '1000000'],
    ['1e20', '100000000000000000000'],
    ['1e21', '1e+21'],
    ['5e21', '5e+21'],
    ['5000000000000000000000', '5e+21'],
    ['1e-5', '0.00001'],
    ['1e-6', '0.000001'],
    ['1e-7', '1e-7'],
    ['1.5e-07', '1.5e-7'],
    ['2.5e-05', '0.000025'],
    ['1e+100', '1e+100'],
    ['1e308', '1e+308'],
    ['1e-300', '1e-300'],
    ['0.30000000000000004', '0.30000000000000004'],
  ];
  for (const [literal, normalized] of NORMALIZED) {
    it(`[V11-1] ${literal} normalizes to ${normalized}`, () => {
      expect(normalizedSpelling(literal), literal).toBe(normalized);
    });
  }
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
        // ③ The literals named in the warnings are exactly this form's literal (when the
        // table says it must be reported) plus the second literal one POSITION embeds.
        // EXPECTED_WARNINGS is a written-down table, not a call to the code under test.
        const expected = expectedWarnedLiterals(position.build(form.literal));
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
