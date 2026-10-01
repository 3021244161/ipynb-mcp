import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  IpynbError,
  WARNING_CODES,
  createWarning,
} from '../../src/core/errors.ts';

describe('[step1] error codes (SPEC §7 closed set)', () => {
  it('defines exactly 24 error-class and 11 warning-class codes (35 total)', () => {
    expect(ERROR_CODES).toHaveLength(24);
    expect(WARNING_CODES).toHaveLength(11);
    expect(ERROR_CODES.length + WARNING_CODES.length).toBe(35);
  });

  it('contains no duplicates and every code is snake_case', () => {
    const all = [...ERROR_CODES, ...WARNING_CODES];
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('IpynbError carries code, message and JSON-safe detail (D13)', () => {
    const err = new IpynbError('cas_mismatch', 'anchor mismatch', {
      failed_op_index: 0,
      expected: 'old',
      actual: 'new',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('IpynbError');
    expect(err.code).toBe('cas_mismatch');
    expect(err.message).toBe('anchor mismatch');
    expect(JSON.parse(JSON.stringify(err.detail))).toEqual({
      failed_op_index: 0,
      expected: 'old',
      actual: 'new',
    });
  });

  it('createWarning builds the warnings[] entry shape', () => {
    expect(createWarning('index_shifted', 'cell indexes shifted by earlier ops')).toEqual({
      code: 'index_shifted',
      message: 'cell indexes shifted by earlier ops',
    });
  });

  it('all code names are pure ASCII English (R16)', () => {
    for (const code of [...ERROR_CODES, ...WARNING_CODES]) {
      expect([...code].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true);
    }
  });
});
