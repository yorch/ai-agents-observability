import { describe, expect, it } from 'vitest';

import { parsePageParam } from '../src/lib/pagination';

describe('parsePageParam', () => {
  it('accepts a positive integer page', () => {
    expect(parsePageParam('1')).toBe(1);
    expect(parsePageParam('7')).toBe(7);
    expect(parsePageParam('1000')).toBe(1000);
  });

  it('defaults to the first page when the param is absent or empty', () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam('')).toBe(1);
  });

  // The original bug: parseInt('abc', 10) is NaN, Math.max(1, NaN) is NaN, and
  // NaN reached Prisma's `skip` — the list rendered empty with no pager back.
  it('falls back on a non-numeric page', () => {
    expect(parsePageParam('abc')).toBe(1);
    expect(parsePageParam('../../etc/passwd')).toBe(1);
  });

  // The regression this replaced it with: Number('1.5') is 1.5, which does NOT
  // make Prisma throw. It produces a fractional offset and returns a slice
  // starting mid-list, presented as a page.
  it('falls back on a fractional page rather than producing a misaligned slice', () => {
    expect(parsePageParam('1.5')).toBe(1);
    expect(parsePageParam('1.001')).toBe(1);
    expect(parsePageParam('2.5')).toBe(1);
  });

  // `1e6` is 1000000 — a real integer, and indistinguishable from someone
  // typing `?page=1000000`. Rejecting the notation but not the plain spelling
  // would be arbitrary, so both are accepted here and the *out-of-range* case
  // is handled where it belongs: Pagination offers a way back to page 1.
  it('accepts scientific notation that denotes an integer', () => {
    expect(parsePageParam('1e6')).toBe(1_000_000);
  });

  it('falls back on non-finite values', () => {
    expect(parsePageParam('Infinity')).toBe(1);
    expect(parsePageParam('1e999')).toBe(1);
    expect(parsePageParam('NaN')).toBe(1);
  });

  it('falls back on zero and negatives — a page is a 1-based index', () => {
    expect(parsePageParam('0')).toBe(1);
    expect(parsePageParam('-3')).toBe(1);
  });

  it('falls back beyond the safe integer range', () => {
    expect(parsePageParam('9007199254740993')).toBe(1);
  });

  it('never returns a value that could produce a fractional offset', () => {
    const inputs = ['1', '2.5', 'abc', '1e6', '-1', '0', '', undefined, 'NaN', '3'];
    for (const input of inputs) {
      const page = parsePageParam(input);
      expect(Number.isSafeInteger(page)).toBe(true);
      expect(page).toBeGreaterThanOrEqual(1);
      expect((page - 1) * 25 === Math.trunc((page - 1) * 25)).toBe(true);
    }
  });
});
