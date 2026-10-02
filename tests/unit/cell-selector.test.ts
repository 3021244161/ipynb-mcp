import { describe, expect, it } from 'vitest';

import { IpynbError } from '../../src/core/errors.js';
import { parseCellSelector } from '../../src/run.js';

function expectInvalid(selector: string): IpynbError {
  try {
    parseCellSelector(selector, [0, 1, 2]);
    throw new Error('expected invalid_targets');
  } catch (cause) {
    if (cause instanceof IpynbError) {
      expect(cause.code).toBe('invalid_targets');
      return cause;
    }
    throw cause;
  }
}

describe('[U13][A10] cell_selector grammar (SPEC §4.7)', () => {
  it('rejects a descending range with invalid_targets', () => {
    expectInvalid('5-3');
  });

  it("rejects '1-2-3' instead of silently truncating to 1-2", () => {
    const err = expectInvalid('1-2-3');
    expect(String((err.detail as Record<string, unknown>)['cell_selector'])).toBe('1-2-3');
  });

  it("[W10] rejects '-1' instead of reading it as the range 0-1", () => {
    // Number('') === 0 made '-1' select cells 0 AND 1: running cells the
    // caller never asked for is the same failure class as '1-2-3'.
    const err = expectInvalid('-1');
    expect(String((err.detail as Record<string, unknown>)['cell_selector'])).toBe('-1');
    expectInvalid('0-');
    expectInvalid('-');
    expectInvalid('1--2');
  });

  it('rejects garbage characters, empty pieces and non-integers', () => {
    expectInvalid('abc');
    expectInvalid('1,,2');
    expectInvalid('1;x');
    expectInvalid('a-2');
  });

  it('accepts all, single indexes, ranges and comma lists (ascending, deduped)', () => {
    expect(parseCellSelector('all', [0, 1, 2])).toEqual([0, 1, 2]);
    expect(parseCellSelector('', [0, 1, 2])).toEqual([0, 1, 2]);
    expect(parseCellSelector('1', [0, 1, 2])).toEqual([1]);
    expect(parseCellSelector('0-2', [0, 1, 2])).toEqual([0, 1, 2]);
    expect(parseCellSelector('2,0,2', [0, 1, 2])).toEqual([0, 2]);
    expect(parseCellSelector('0-1,3', [0, 1, 2, 3])).toEqual([0, 1, 3]);
  });
});
