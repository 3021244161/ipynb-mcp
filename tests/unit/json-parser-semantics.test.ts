// The LANGUAGE-SEMANTICS matrix for the hand-written JSON parser (review v10 V10-6,
// and AGENTS §9's fifth rule: a parser you wrote yourself needs a matrix of the
// language's edges, not of the shapes you happened to think about).
//
// Why this file exists: `parseJsonExact` replaced `JSON.parse` for the notebook
// document, the sidecar protocol and the write-back. `JSON.parse` treats `__proto__`
// as an ordinary OWN property; a parser that does `result[key] = value` does not —
// it runs `Object.prototype`'s `__proto__` setter, so the key VANISHES from the
// object and from every later write. That is "delete data from the user's file,
// silently", and it survived a v9 round that was specifically about not doing that.
//
// Every case below asserts the SAME three things (the layers from AGENTS §9):
//   ① the parsed value equals what `JSON.parse` produces (the reference semantics);
//   ② `stringifyJsonExact` writes back the bytes that came in (re-indented only) —
//      so nothing was dropped, reordered or rewritten;
//   ③ and, for the hostile keys, that the resulting object is still a normal object
//      with a working prototype (`constructor`, `toString`, `hasOwnProperty` must
//      behave), so fixing ① cannot introduce a subtle second problem.
//
// The reference is `JSON.parse`, which is not "our own dialect": it is the
// ECMAScript definition of the format, and the previous implementation used it.

import { describe, expect, it } from 'vitest';

import { isExactNumber, parseJsonExact, stringifyJsonExact } from '../../src/core/json-exact.js';

/**
 * Structural equality that also distinguishes `-0` from `0`.
 *
 * `toEqual` is the only structural matcher available here that survives a key literally
 * named `constructor`: `toStrictEqual` rejects that shape with "no visual difference"
 * (vitest 3.2.7), which is a matcher artefact, not a defect in the parser. So the
 * comparison is done with `toEqual` and the one thing it is loose about is checked
 * separately, recursively — which is strictly more than `toStrictEqual` would have
 * given us anyway, since it refuses to compare these objects at all.
 */
function expectSameValue(actual: unknown, expected: unknown, where = '$'): void {
  expect(actual, where).toEqual(expected);
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Object.is(actual, expected), `${where}: ${String(actual)} vs ${String(expected)}`).toBe(true);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual).toHaveLength(expected.length);
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

/** The same value via the platform parser, for comparison. */
function reference(text: string): unknown {
  return JSON.parse(text);
}

/**
 * The parsed tree with every exact-number marker replaced by the number it stands for.
 *
 * Structural equality with `JSON.parse` cannot be asserted directly any more: a literal
 * like `-0` or `1E+2` is deliberately kept as a marker (a JS number would not write the
 * same bytes back). Comparing the EVALUATED tree is the honest form of the claim —
 * "the same value, with the same keys" — and the byte-level claim is asserted
 * separately against the reference serializer, which is where it belongs.
 */
function evaluated(value: unknown): unknown {
  if (isExactNumber(value)) {
    return Number(value.__ipynb_exact_number__);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => evaluated(entry));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(result, key, { value: evaluated(entry), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value;
}

/**
 * The number a parsed scalar stands for, marker or not.
 *
 * Needed because `-0` is a marker (a JS number would lose its sign) while `0` is not,
 * so the two are compared by VALUE with `Object.is` and the boundary is asserted
 * explicitly in the case that cares.
 */
function numberOf(value: unknown): number {
  return isExactNumber(value) ? Number(value.__ipynb_exact_number__) : (value as number);
}

/** Serialized both ways, with the same indentation the notebook uses. */
function writeBoth(value: unknown): { exact: string; reference: string } {
  return { exact: stringifyJsonExact(value, 1), reference: JSON.stringify(value, null, 1) };
}

interface Case {
  readonly name: string;
  /** Raw JSON text, never a JS literal: `{__proto__: 1}` in source is a different thing. */
  readonly text: string;
  /**
   * Set when this implementation is deliberately NOT byte-identical to
   * `JSON.stringify`: currently only `-0`, which the built-in writes as `0`.
   */
  readonly differsFromReference?: boolean;
}

/**
 * Keys and shapes that collide with JavaScript's own object semantics.
 *
 * These are the cells the v10 review named, plus the ones reading the parser made me
 * think of. `__proto__` is the one that was actually broken; the rest are here because
 * "the key is also a name on Object.prototype" is the whole class.
 */
const SEMANTIC_CASES: readonly Case[] = [
  { name: '__proto__ as an object key', text: '{"__proto__":{"polluted":1},"keep":"me"}' },
  { name: '__proto__ holding a string', text: '{"__proto__":"text","a":1}' },
  { name: '__proto__ holding null', text: '{"__proto__":null}' },
  { name: '__proto__ nested two levels deep', text: '{"a":{"b":{"__proto__":{"deep":true}}}}' },
  { name: '__proto__ inside an array element', text: '[{"__proto__":{"inArray":1}}]' },
  { name: '__proto__ inside an array of arrays', text: '[[{"__proto__":[]}]]' },
  { name: '__proto__ twice in one object', text: '{"__proto__":1,"__proto__":2}' },
  { name: 'proto key spelled with escapes', text: '{"\\u005f_proto__":{"escaped":true}}' },
  { name: 'constructor as an object key', text: '{"constructor":1,"prototype":2}' },
  { name: 'constructor nested', text: '{"a":{"constructor":{"prototype":{"x":1}}}}' },
  { name: 'keys that shadow Object methods', text: '{"toString":1,"valueOf":2,"hasOwnProperty":3}' },
  { name: 'an empty key', text: '{"":1,"a":""}' },
  { name: 'a key that is only whitespace', text: '{" ":1,"\\t":2}' },
  { name: 'duplicate keys, last wins', text: '{"a":1,"a":2,"b":3}' },
  { name: 'duplicate keys where the last is an object', text: '{"a":1,"a":{"b":2}}' },
  { name: 'duplicate __proto__ keys', text: '{"__proto__":{"first":1},"__proto__":{"second":2}}' },
  { name: 'negative zero', text: '-0', differsFromReference: true },
  { name: 'negative zero as a value', text: '{"z":-0}', differsFromReference: true },
  { name: 'negative zero in an array', text: '[-0,0]', differsFromReference: true },
  { name: 'a non-BMP key (surrogate pair)', text: '{"\u{1F600}":1}' },
  { name: 'a lone high surrogate in a key', text: '{"\\ud83d":1}' },
  { name: 'a lone low surrogate in a value', text: '{"a":"\\ude00"}' },
  { name: 'non-BMP key nested with an escape', text: '{"\\ud83d\\ude00":{"\\ud83d\\ude00":1}}' },
  { name: 'every short escape', text: '{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t"}' },
  { name: 'unicode escapes, including an uppercase hex', text: '{"a":"\\u0041\\u00e9\\uFFFD"}' },
  { name: 'the empty object and array', text: '{"o":{},"a":[]}' },
  { name: 'nulls where values are expected', text: '{"a":null,"b":[null]}' },
  { name: 'escaped delimiters inside strings', text: '{"a":"{]},\\":\\""}' },
  { name: 'whitespace around every token', text: ' \t\r\n{ "a" : [ 1 , 2 ] , "b" : { } } \n' },
];

describe('[V10-6] the hand-written parser matches JSON.parse on JavaScript-semantics edges', () => {
  for (const testCase of SEMANTIC_CASES) {
    it(`[V10-6] parses ${testCase.name} the way the language does`, () => {
      const parsed = parseJsonExact(testCase.text);
      // `expectSameValue` compares own enumerable properties and array elements and
      // keeps `Object.is` semantics for numbers; a dropped `__proto__` key shows up
      // here immediately (the reference has it, we do not). `evaluated` unwraps the
      // exact-number markers a JS number would round.
      expectSameValue(evaluated(parsed), reference(testCase.text));
      // Own-key presence, spelled out: `toEqual` alone would pass for two objects that
      // both lack the key, which is exactly the v10-6 shape.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const key of Object.keys(reference(testCase.text) as object)) {
          expect(Object.prototype.hasOwnProperty.call(parsed, key), `own key ${JSON.stringify(key)}`).toBe(true);
        }
      }
    });

    it(`[V10-6] writes ${testCase.name} back without losing a character`, () => {
      const parsed = parseJsonExact(testCase.text);
      const both = writeBoth(parsed);
      if (testCase.differsFromReference === true) {
        // The documented, deliberate differences: `-0` keeps its sign where
        // `JSON.stringify` writes `0`, and the reference serializer writes our marker
        // as the object it is. Both are asserted in the case that is about them.
        expect(both.exact).not.toBe(both.reference);
        expect(parseJsonExact(both.exact)).toEqual(parsed);
        return;
      }
      // Byte-for-byte with the reference serializer: this is the assertion that catches
      // "the key is gone", "the key moved" and "the value changed shape" in one line,
      // and it is the one that matters, because the write-back reaches the user's file.
      expect(both.exact).toBe(both.reference);
      // And a full round trip is stable: the bytes we would write parse back to a tree
      // that writes the same bytes again.
      const rewritten = stringifyJsonExact(parseJsonExact(stringifyJsonExact(parsed)), 1);
      expect(rewritten).toBe(stringifyJsonExact(parsed, 1));
    });
  }

  it('[V10-6] negative zero keeps its sign through the document', () => {
    // `JSON.parse('-0')` gives `-0` and `String(-0)` is `'0'`, so a plain number cannot
    // carry this literal: without the sign being kept, the value silently becomes `0`.
    // `JSON.stringify(-0)` writes `0` as well — JSON has no negative zero — but the
    // point here is that OUR write-back of a document we parsed writes the bytes the
    // user had, and the value the model reads is still `-0`.
    const text = '{"z":-0,"list":[-0,0],"nested":{"deep":-0}}';
    const parsed = parseJsonExact(text) as { z: unknown; list: unknown[]; nested: { deep: unknown } };
    expect(Object.is(numberOf(parsed.z), -0)).toBe(true);
    expect(Object.is(numberOf(parsed.list[0]), -0)).toBe(true);
    expect(Object.is(numberOf(parsed.list[1]), 0)).toBe(true);
    expect(Object.is(numberOf(parsed.nested.deep), -0)).toBe(true);
    expect(stringifyJsonExact(parsed)).toBe(text);
    expect(stringifyJsonExact(parsed, 1)).toContain('-0');
  });

  it('[V10-6] a parsed object is still an ordinary object', () => {
    // The fix for the dropped key must not turn every parsed object into something
    // with no prototype: ① `Object.create(null)` would break `hasOwnProperty` and the
    // spread of the document into other structures, and ② a polluted prototype would
    // be worse than the bug. Both are checked here.
    const parsed = parseJsonExact('{"__proto__":{"polluted":1},"keep":"me"}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(typeof parsed['toString']).toBe('function');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'hasOwnProperty')).toBe(false);
    // The global prototype must not have been touched by the file's content: this is
    // the difference between "we stored a key" and "we ran a setter".
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect('polluted' in parsed).toBe(false);
    // Property order is the file's order, which is what the writer depends on.
    expect(Object.keys(parsed)).toEqual(['__proto__', 'keep']);
  });

  it('[V10-6] __proto__ keys survive the full document round trip', () => {
    // The shape from the review, at document scale: a `__proto__` key in the notebook
    // metadata, in a cell's metadata, and inside a json output value. Written with the
    // SAME indentation the writer produces, so "the bytes come back" is assertable.
    const text = `${JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          execution_count: null,
          id: 'c0',
          metadata: JSON.parse('{"__proto__": {"inCellMetadata": 1}, "keep": "me"}'),
          outputs: [
            {
              data: { 'application/json': JSON.parse('{"__proto__": {"inOutput": true}, "safe": 1}') },
              metadata: {},
              output_type: 'display_data',
            },
          ],
          source: ['x'],
        },
      ],
      metadata: JSON.parse('{"__proto__": {"inNotebookMetadata": 1}}'),
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 1)}\n`;
    // The FIXTURE is built with `JSON.parse`, which keeps `__proto__` as a real key —
    // the whole point is what OUR parser does with those same bytes.
    expect(text).toContain('"__proto__"');

    const parsed = parseJsonExact(text);
    expect(stringifyJsonExact(parsed, 1)).toBe(text.replace(/\n$/, ''));
    // A second pass must be stable: parse → write → parse → write.
    expect(parseJsonExact(stringifyJsonExact(parsed, 1))).toEqual(parsed);
    // Every occurrence is still there, in the file we would write.
    const written = stringifyJsonExact(parsed, 1);
    expect(written.match(/"__proto__"/g)).toHaveLength(3);
    // …and so is every VALUE under it, which is what "the key was dropped" hid before.
    expect(written).toContain('inCellMetadata');
    expect(written).toContain('inOutput');
    expect(written).toContain('inNotebookMetadata');
  });
});

describe('[V10-6] the parser rejects what JSON rejects', () => {
  const INVALID = [
    '[1,,3]',
    '{"a":1,}',
    '{,}',
    "{'a':1}",
    '{a:1}',
    '{"a" 1}',
    '01',
    '1.',
    '.1',
    '+1',
    '- 1',
    'Infinity',
    'NaN',
    '"unterminated',
    '{"a":1}}',
    '{} {}',
    'tru',
    'nul',
    '"\\x41"',
    '"\\u12"',
    '',
    ' ',
  ];

  for (const text of INVALID) {
    it(`[V10-6] rejects ${JSON.stringify(text)} the way JSON.parse does`, () => {
      let referenceThrew = false;
      try {
        JSON.parse(text);
      } catch {
        referenceThrew = true;
      }
      expect(referenceThrew, 'the reference must reject it too, or this case is wrong').toBe(true);
      expect(() => parseJsonExact(text)).toThrow(SyntaxError);
    });
  }

  it('[V10-6] accepts the same deep nesting JSON.parse does', () => {
    // A parser is also its recursion: 200 levels is well past anything a notebook
    // needs, and both sides must agree rather than one of them blowing the stack.
    const deep = `${'['.repeat(200)}1${']'.repeat(200)}`;
    expect(parseJsonExact(deep)).toEqual(reference(deep));
    const deepObject = `${'{"a":'.repeat(100)}1${'}'.repeat(100)}`;
    expect(parseJsonExact(deepObject)).toEqual(reference(deepObject));
  });
});
