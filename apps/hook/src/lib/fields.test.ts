import { describe, expect, it } from 'bun:test';

import { isPlainRecord, isRecord, optionalNonNegativeInt, pickString, pickValue } from './fields';

describe('optionalNonNegativeInt (P14-010)', () => {
  it('passes a finite non-negative number through, truncated', () => {
    expect(optionalNonNegativeInt(245)).toBe(245);
    expect(optionalNonNegativeInt(0)).toBe(0);
    expect(optionalNonNegativeInt(12.9)).toBe(12);
  });

  it('returns null for undefined and null — absent means unknown, not 0', () => {
    expect(optionalNonNegativeInt(undefined)).toBe(null);
    expect(optionalNonNegativeInt(null)).toBe(null);
  });

  it('returns null for a negative number rather than clamping to 0', () => {
    expect(optionalNonNegativeInt(-5)).toBe(null);
  });

  it('returns null for non-finite numbers', () => {
    expect(optionalNonNegativeInt(Number.NaN)).toBe(null);
    expect(optionalNonNegativeInt(Number.POSITIVE_INFINITY)).toBe(null);
    expect(optionalNonNegativeInt(Number.NEGATIVE_INFINITY)).toBe(null);
  });

  it('returns null for non-number types rather than throwing', () => {
    expect(optionalNonNegativeInt('245')).toBe(null);
    expect(optionalNonNegativeInt(true)).toBe(null);
    expect(optionalNonNegativeInt({})).toBe(null);
    expect(optionalNonNegativeInt([])).toBe(null);
    expect(optionalNonNegativeInt(Symbol('x'))).toBe(null);
  });
});

// Pre-existing helpers — smoke-tested here only because this file didn't exist
// before P14-010; not a re-review of their established behavior.
describe('fields primitives smoke test', () => {
  it('isRecord / isPlainRecord', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isPlainRecord([])).toBe(false);
  });

  it('pickString / pickValue skip empty strings', () => {
    expect(pickString({ a: '', b: 'x' }, ['a', 'b'])).toBe('x');
    expect(pickValue({ a: '', b: 'x' }, ['a', 'b'])).toBe('x');
  });
});
