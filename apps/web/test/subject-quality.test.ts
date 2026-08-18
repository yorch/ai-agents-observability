import { describe, expect, it } from 'vitest';

import { fisherExactTwoTailed } from '../src/lib/stats';
import type { SubjectArm, SubjectQualityRow } from '../src/lib/subject-quality-queries';
import {
  compareSubjectOutcomes,
  SUBJECT_MIN_CALLS,
  SUBJECT_MIN_SESSIONS_PER_ARM,
  subjectErrorRate,
} from '../src/lib/subject-quality-queries';

// P13-004's gates are the feature. A skill comparison that reports a number on
// six sessions is not a weaker version of this surface — it is the failure mode
// the surface exists to avoid, so the gate is what gets tested hardest.

function arm(partial: Partial<SubjectArm> = {}): SubjectArm {
  return {
    ciClean: 0,
    ciKnown: 0,
    medianFriction: null,
    mergedPrs: 0,
    revertedPrs: 0,
    sessionCount: 0,
    ...partial,
  };
}

function row(partial: Partial<SubjectQualityRow> = {}): SubjectQualityRow {
  return {
    distinctUsers: 3,
    downstreamCalls: 0,
    downstreamErrors: 0,
    invocations: 10,
    kind: 'skill',
    name: 'deep-research',
    with: arm(),
    without: arm(),
    ...partial,
  };
}

describe('subjectErrorRate', () => {
  it('returns null below the call floor rather than a rate off a handful of calls', () => {
    expect(
      subjectErrorRate(row({ downstreamCalls: SUBJECT_MIN_CALLS - 1, downstreamErrors: 3 })),
    ).toBeNull();
  });

  it('reports the rate once the floor is cleared', () => {
    expect(subjectErrorRate(row({ downstreamCalls: 200, downstreamErrors: 10 }))).toBeCloseTo(
      0.05,
      6,
    );
  });
});

describe('compareSubjectOutcomes', () => {
  const big = SUBJECT_MIN_SESSIONS_PER_ARM * 10;

  it('reports not-measurable, and null rather than p = 1, on a thin arm', () => {
    const thin = row({
      with: arm({ ciClean: 2, ciKnown: 3, mergedPrs: 3, revertedPrs: 1, sessionCount: 3 }),
      without: arm({
        ciClean: 90,
        ciKnown: 100,
        mergedPrs: 100,
        revertedPrs: 5,
        sessionCount: big,
      }),
    });
    for (const c of compareSubjectOutcomes(thin)) {
      expect(c.measurable).toBe(false);
      // A p-value of 1 reads as "tested, no effect"; null reads as "not tested".
      expect(c.pValue).toBeNull();
    }
  });

  it('still exposes the raw rates when the comparison is gated', () => {
    const thin = row({
      with: arm({ mergedPrs: 3, revertedPrs: 1, sessionCount: 3 }),
      without: arm({ mergedPrs: 100, revertedPrs: 5, sessionCount: big }),
    });
    const reverted = compareSubjectOutcomes(thin).find((c) => c.outcome === 'reverted');
    expect(reverted?.rateWith).toBeCloseTo(1 / 3, 6);
    expect(reverted?.rateWithout).toBeCloseTo(0.05, 6);
  });

  it('gates the outcome arms independently of the session arms', () => {
    // Plenty of sessions on both sides, but almost none of them produced a
    // merged PR — the revert comparison must stay gated even though the session
    // counts look healthy.
    const fewPrs = row({
      with: arm({ mergedPrs: 2, revertedPrs: 1, sessionCount: big }),
      without: arm({ mergedPrs: 4, revertedPrs: 1, sessionCount: big }),
    });
    const reverted = compareSubjectOutcomes(fewPrs).find((c) => c.outcome === 'reverted');
    expect(reverted?.measurable).toBe(false);
  });

  it('routes a measurable comparison through the shared Fisher implementation', () => {
    const measurable = row({
      with: arm({ ciClean: 40, ciKnown: 60, mergedPrs: 60, revertedPrs: 18, sessionCount: big }),
      without: arm({
        ciClean: 90,
        ciKnown: 100,
        mergedPrs: 100,
        revertedPrs: 4,
        sessionCount: big,
      }),
    });
    const [reverted, ciFailed] = compareSubjectOutcomes(measurable);

    expect(reverted?.measurable).toBe(true);
    expect(reverted?.pValue).toBeCloseTo(fisherExactTwoTailed(18, 42, 4, 96), 12);
    expect(reverted?.pValue).toBeLessThan(0.05);

    expect(ciFailed?.measurable).toBe(true);
    expect(ciFailed?.pValue).toBeCloseTo(fisherExactTwoTailed(20, 40, 10, 90), 12);
  });

  it('adversarial: identical rates on both arms are not significant', () => {
    const same = row({
      with: arm({ ciClean: 90, ciKnown: 100, mergedPrs: 100, revertedPrs: 5, sessionCount: big }),
      without: arm({
        ciClean: 90,
        ciKnown: 100,
        mergedPrs: 100,
        revertedPrs: 5,
        sessionCount: big,
      }),
    });
    for (const c of compareSubjectOutcomes(same)) {
      expect(c.measurable).toBe(true);
      expect(c.pValue ?? 0).toBeGreaterThan(0.05);
    }
  });

  it('never returns a verdict field — only rates, sizes and p-values', () => {
    const c = compareSubjectOutcomes(row())[0];
    expect(Object.keys(c ?? {}).sort()).toEqual([
      'measurable',
      'outcome',
      'pValue',
      'rateWith',
      'rateWithout',
    ]);
  });
});
