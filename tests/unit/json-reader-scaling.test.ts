import { describe, expect, it } from 'vitest';

import { parseJsonExact } from '../../src/core/json-exact.js';

/**
 * [V13-7] The reader must finish an escape-dense string in time linear in its length.
 *
 * The previous release fixed a 16-fold memory defect in this function and introduced a worse one: it
 * searched for the closing quote and the next escape with two INDEPENDENT `indexOf` calls, each
 * starting from the current position, so every escape re-scanned the whole remaining text. Escapes are
 * not exotic — `\n` is one — so any cell source with line breaks, or any log-like output, went
 * quadratic. Measured on a legal notebook whose source has an escape every ~20 characters:
 * 0.5/1/2 MiB took 413/1611/6362 ms (a clean doubling-to-quadrupling), and 6.3 MiB turned a 335 ms
 * read into 56.5 s with the single-threaded server unresponsive throughout (review v13).
 *
 * WHY A TIME BOUND AND NOT SOMETHING ELSE. Content assertions cannot see this: the quadratic version
 * returns byte-identical values, just slowly, which is why it survived a review round whose every unit
 * case passed. The only observable difference is elapsed time, so the assertion has to be about
 * elapsed time — with a bound far above the real cost (the fixed reader does 4 MiB in ~45 ms) so that
 * it cannot fail on a loaded machine while still failing the 4-second-per-MiB regression by orders of
 * magnitude.
 *
 * The bound is stated per MiB and the sizes are doubled on purpose: a quadratic reader's cost grows
 * with the SQUARE of the size, so measuring two sizes and comparing their ratio distinguishes "slow"
 * from "quadratic" even on a machine whose absolute speed I cannot predict.
 */
function escapeDense(mebibytes: number): { text: string; expected: string } {
  // `\n` only: it IS an escape in JSON, and the content carries no quote or backslash of its own, so
  // this is a valid JSON string exercising exactly the shape the defect was about.
  const unit = 'print(line)\\n';
  const body = unit.repeat(Math.ceil((mebibytes * 1024 * 1024) / unit.length));
  const text = `"${body}"`;
  // `JSON.parse` is the authority for BOTH halves of the fixture, so a wrong expectation in this file
  // cannot be mistaken for a reader defect. (The first version computed the expected length by hand and
  // got it wrong: `\n` is two characters in the source and one in the value.)
  return { text, expected: JSON.parse(text) as string };
}

describe('[V13-7] an escape-dense string is read in linear time', () => {
  it('[V13-7] doubling the input at most doubles the cost, and stays far inside a wall-clock bound', () => {
    const timings: number[] = [];
    for (const mebibytes of [1, 2]) {
      const { text, expected } = escapeDense(mebibytes);
      const value = parseJsonExact(text) as string;
      // The value must still be right, or a fast wrong reader would pass the timing assertion.
      expect(value).toBe(expected);
      // A probe assertion: the payload must be big enough for the bound to mean anything, and must
      // actually contain the escapes this case is named for. Without this, a fixture that stopped
      // producing escapes would make the timing assertion vacuous.
      expect(expected.length).toBeGreaterThan(mebibytes * 1024 * 1024 * 0.9);
      expect(expected.split('\n').length - 1).toBeGreaterThan(50_000);
      // FASTEST OF SEVERAL RUNS, not one sample. A single sample on a machine doing anything else is
      // noise, and the ratio of two noisy samples is worse: the reviewer measured 25 rounds of this exact
      // fixture at 11.3-20.7 ms (1 MiB) and 29.6-40.0 ms (2 MiB), giving a ratio whose median is 2.15 and
      // whose MAXIMUM is 3.22 — against a quadratic reader's 3.91. A threshold of 3 therefore sat inside
      // the noise and produced 5 false reds in 25 runs. The minimum is the sample least contaminated by
      // scheduling, so taking the best of a few makes both the absolute bound and the ratio stable, and
      // the threshold moves to 4 where it still separates linear from quadratic (v14 V14-9).
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = performance.now();
        parseJsonExact(text);
        best = Math.min(best, performance.now() - started);
      }
      timings.push(best);
      expect(best, `${String(mebibytes)} MiB best-of-5 took ${best.toFixed(0)} ms`).toBeLessThan(3_000);
    }
    const [one, two] = timings as [number, number];
    // Quadratic growth on a doubling is a factor of ~4; linear is ~2. The threshold is 4 MINUS the noise
    // margin the best-of-5 buys, which is the reviewer's suggested value: it still catches the 3.91 that
    // the old implementation measured, while a best-of-5 ratio for a linear reader sits near 2.
    const ratio = two / Math.max(one, 1);
    expect(
      ratio,
      `1 MiB took ${one.toFixed(1)} ms, 2 MiB took ${two.toFixed(1)} ms (ratio ${ratio.toFixed(2)}); a quadratic reader scales with the square`,
    ).toBeLessThan(4);
    // An absolute bound as well, so a uniformly slow machine cannot hide a regression behind a favourable
    // ratio: the quadratic version needed ~9 s for the 2 MiB case, the fixed one ~35 ms.
    expect(two, `2 MiB of escape-dense source took ${two.toFixed(0)} ms`).toBeLessThan(3_000);
  });
});

describe('[V13-7] the escape shapes the bounded search can get wrong', () => {
  // Hand-written expectations, checked against `JSON.parse` rather than derived from the implementation
  // (AGENTS §9). The first attempt at the bounded search passed the plain cases and broke exactly
  // these: `\\` pairs consumed one character at a time, and `\"` treated as the end of the string.
  const CASES: Array<[string, string]> = [
    ['"a\\nb"', 'a\nb'],
    ['"a\\\\b"', 'a\\b'],
    ['"a\\\\\\\\b"', 'a\\\\b'],
    ['"\\""', '"'],
    ['"\\"\\""', '""'],
    ['"a\\"b"', 'a"b'],
    ['"\\\\\\\\"', '\\\\'],
    ['"\\n\\t\\r\\b\\f\\/"', '\n\t\r\b\f/'],
    ['"\\u0041"', 'A'],
    ['"\\u4e2d"', '中'],
    ['"plain"', 'plain'],
    ['""', ''],
    ['"\\n"', '\n'],
    ['"\\\\n"', '\\n'],
    ['"a\\nb\\tc"', 'a\nb\tc'],
    ['"end\\n"', 'end\n'],
  ];

  it('[V13-7] every escape shape matches JSON.parse, including backslash runs and escaped quotes', () => {
    for (const [text, want] of CASES) {
      // The table is checked against the authority first: if my expectation were wrong, the failure
      // would be attributed to the reader.
      expect(JSON.parse(text), `the table entry for ${text} must match JSON.parse`).toBe(want);
      expect(parseJsonExact(text), `reading ${text}`).toBe(want);
    }
  });

  it('[V13-7] a document whose values contain escapes round-trips, not just the bare string', () => {
    // The bare-string cases above missed the bug that broke every document: a string consumed its
    // closing quote, so `{"source": ["x = 1\n"]}` failed with "Expected ':' after a property name".
    // A nested document asserts the cursor ends up in the right place, which a value-only comparison
    // cannot.
    const documents = [
      '{"source": ["x = 1\\n"]}',
      '{"cells": [{"source": ["a\\nb"], "outputs": []}]}',
      '{"mixed": "a\\nb\\\\c\\"d\\te"}',
      '{"path": "C:\\\\Users\\\\x"}',
    ];
    for (const text of documents) {
      expect(parseJsonExact(text), `reading ${text}`).toEqual(JSON.parse(text));
    }
  });
});
