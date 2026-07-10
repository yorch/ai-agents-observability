import { describe, expect, it } from 'vitest';

import { compareBandsToBaseline, fisherExactTwoTailed, fmtPValue } from '../src/lib/stats.js';

describe('fisherExactTwoTailed', () => {
  it('matches the classic scipy/R reference table [[1,9],[11,3]]', () => {
    // scipy.stats.fisher_exact([[1, 9], [11, 3]]) → p ≈ 0.0027594
    expect(fisherExactTwoTailed(1, 9, 11, 3)).toBeCloseTo(0.0027594, 6);
  });

  it("matches Fisher's tea-tasting 4×4 split [[3,1],[1,3]]", () => {
    // fisher.test(matrix(c(3,1,1,3), nrow=2)) → p ≈ 0.4857143
    expect(fisherExactTwoTailed(3, 1, 1, 3)).toBeCloseTo(0.4857143, 6);
  });

  it('returns 1 for identical proportions', () => {
    expect(fisherExactTwoTailed(5, 5, 5, 5)).toBe(1);
  });

  it('returns 1 for degenerate margins (empty group / empty column)', () => {
    expect(fisherExactTwoTailed(0, 0, 3, 7)).toBe(1); // empty group 1
    expect(fisherExactTwoTailed(0, 10, 0, 10)).toBe(1); // no successes anywhere
    expect(fisherExactTwoTailed(10, 0, 10, 0)).toBe(1); // no failures anywhere
  });

  it('detects a strong difference at moderate n', () => {
    // 20/100 reverted vs 2/100 reverted — clearly significant.
    const p = fisherExactTwoTailed(20, 80, 2, 98);
    expect(p).toBeLessThan(0.001);
  });

  it('stays insignificant on tiny samples even with a large rate gap', () => {
    // 2/4 vs 0/5 looks like 50% vs 0% but carries almost no evidence.
    expect(fisherExactTwoTailed(2, 2, 0, 5)).toBeGreaterThan(0.05);
  });

  it('rejects non-integer or negative counts', () => {
    expect(() => fisherExactTwoTailed(1.5, 2, 3, 4)).toThrow(RangeError);
    expect(() => fisherExactTwoTailed(-1, 2, 3, 4)).toThrow(RangeError);
  });
});

describe('compareBandsToBaseline', () => {
  const low = { band: 'low', bugLinked: 1, ciFailed: 5, mergedPrs: 100, reverted: 2 };
  const high = { band: 'high', bugLinked: 6, ciFailed: 20, mergedPrs: 40, reverted: 8 };

  it('tests every non-baseline band × outcome against the low band', () => {
    const comparisons = compareBandsToBaseline([low, high]);
    expect(comparisons.map((c) => `${c.band}:${c.outcome}`)).toEqual([
      'high:reverted',
      'high:ciFailed',
      'high:bugLinked',
    ]);
    // 8/40 vs 2/100 reverted is a real gap → significant.
    const reverted = comparisons.find((c) => c.outcome === 'reverted');
    expect(reverted?.pValue).toBeLessThan(0.05);
    // Every p-value is a valid probability.
    for (const c of comparisons) {
      expect(c.pValue).toBeGreaterThan(0);
      expect(c.pValue).toBeLessThanOrEqual(1);
    }
  });

  it('returns nothing without a usable baseline', () => {
    expect(compareBandsToBaseline([high])).toEqual([]);
    expect(compareBandsToBaseline([{ ...low, mergedPrs: 0 }, high])).toEqual([]);
  });

  it('skips empty non-baseline bands', () => {
    const empty = { band: 'medium', bugLinked: 0, ciFailed: 0, mergedPrs: 0, reverted: 0 };
    expect(compareBandsToBaseline([low, empty])).toEqual([]);
  });
});

describe('fmtPValue', () => {
  it('formats to three decimals with a floor', () => {
    expect(fmtPValue(0.0004)).toBe('p < 0.001');
    expect(fmtPValue(0.049)).toBe('p = 0.049');
    expect(fmtPValue(0.4857143)).toBe('p = 0.486');
  });
});
