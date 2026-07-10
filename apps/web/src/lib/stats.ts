// Small, dependency-free statistics helpers for the quality-correlation
// surfaces. Fisher's exact test is used (rather than a z/chi-squared
// approximation) because band sample sizes start tiny and the test must stay
// honest at any n — with few PRs it simply won't reach significance, which is
// the correct answer, not a rendering problem.

// Cumulative log-factorial cache, grown on demand. Table totals are merged-PR
// counts (thousands at most), so the cache stays small.
const logFactCache: number[] = [0, 0];

function logFactorial(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) {
    logFactCache.push((logFactCache[i - 1] as number) + Math.log(i));
  }
  return logFactCache[n] as number;
}

// log P(X = a) for a 2×2 table with fixed margins: row sums r1/r2, first
// column sum c1, grand total n (hypergeometric probability of the table).
function logTableProb(a: number, r1: number, r2: number, c1: number, n: number): number {
  const b = r1 - a;
  const c = c1 - a;
  const d = r2 - c;
  return (
    logFactorial(r1) +
    logFactorial(r2) +
    logFactorial(c1) +
    logFactorial(n - c1) -
    (logFactorial(n) + logFactorial(a) + logFactorial(b) + logFactorial(c) + logFactorial(d))
  );
}

/**
 * Two-tailed Fisher's exact test on the 2×2 contingency table
 *
 * ```
 *              success   failure
 *   group 1       a         b
 *   group 2       c         d
 * ```
 *
 * Returns the p-value: the total probability, over all tables with the same
 * margins, of outcomes at most as likely as the observed one (the standard
 * two-sided definition, matching R's fisher.test and scipy's fisher_exact).
 * Degenerate margins (an empty group or an all-success/all-failure column)
 * carry no evidence either way and return 1.
 */
export function fisherExactTwoTailed(a: number, b: number, c: number, d: number): number {
  if (a < 0 || b < 0 || c < 0 || d < 0 || ![a, b, c, d].every(Number.isInteger)) {
    throw new RangeError('fisherExactTwoTailed requires non-negative integer cell counts');
  }
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  if (r1 === 0 || r2 === 0 || c1 === 0 || c1 === n) {
    return 1;
  }

  const logPObserved = logTableProb(a, r1, r2, c1, n);
  // Sum every table (indexed by its top-left cell) whose probability does not
  // exceed the observed table's. The 1e-7 slack in log space is the standard
  // relative tolerance so the observed table always counts itself despite
  // floating-point noise.
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(c1, r1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const logP = logTableProb(x, r1, r2, c1, n);
    if (logP <= logPObserved + 1e-7) {
      p += Math.exp(logP);
    }
  }
  return Math.min(1, p);
}

export type BandOutcomeCounts = {
  band: string;
  bugLinked: number;
  ciFailed: number;
  mergedPrs: number;
  reverted: number;
};

export type BandOutcomeKey = 'bugLinked' | 'ciFailed' | 'reverted';

export const BAND_OUTCOME_KEYS: readonly BandOutcomeKey[] = ['reverted', 'ciFailed', 'bugLinked'];

export type BandComparison = {
  band: string;
  outcome: BandOutcomeKey;
  pValue: number;
};

/**
 * Tests each non-baseline friction band's outcome rates against the baseline
 * band (low friction by default): one two-tailed Fisher's exact test per
 * (band, outcome) pair on the affected-vs-unaffected 2×2 table. Returns no
 * comparison for a missing/empty baseline — with nothing to compare against
 * there is no test, not a p-value of 1. Avg cost is deliberately not tested:
 * it is a mean without variance data, so no honest test exists here.
 */
export function compareBandsToBaseline(
  bands: readonly BandOutcomeCounts[],
  baselineBand = 'low',
): BandComparison[] {
  const baseline = bands.find((b) => b.band === baselineBand);
  if (!baseline || baseline.mergedPrs === 0) {
    return [];
  }
  const comparisons: BandComparison[] = [];
  for (const band of bands) {
    if (band.band === baselineBand || band.mergedPrs === 0) {
      continue;
    }
    for (const outcome of BAND_OUTCOME_KEYS) {
      comparisons.push({
        band: band.band,
        outcome,
        pValue: fisherExactTwoTailed(
          band[outcome],
          band.mergedPrs - band[outcome],
          baseline[outcome],
          baseline.mergedPrs - baseline[outcome],
        ),
      });
    }
  }
  return comparisons;
}

/** "p < 0.001" below display precision, otherwise "p = 0.049" (3 decimals). */
export function fmtPValue(p: number): string {
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}
