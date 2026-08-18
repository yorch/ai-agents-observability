import { describe, expect, it } from 'vitest';
import { evaluateRoutingProjection, type RoutingProjectionSnapshot } from './routing-analysis';

const PROJECTION: RoutingProjectionSnapshot = {
  agentType: 'CLAUDE_CODE',
  cheapCategories: ['fs_read', 'search'],
  cheapCategoryCalls: 120,
  cheapCategorySpendUsd: 50,
  id: 1n,
  model: 'claude-opus-4-8',
  projectedSavingHighUsd: 45,
  projectedSavingLowUsd: 25,
  projectedWindowDays: 30,
  windowEnd: new Date('2026-08-01T00:00:00.000Z'),
  windowStart: new Date('2026-07-02T00:00:00.000Z'),
};

describe('evaluateRoutingProjection', () => {
  it('returns not_measurable below realized-call threshold', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineCheapSpendUsd: 50,
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      baselineRevertRate: 0.05,
      realizedCheapCalls: 12,
      realizedCheapSpendUsd: 30,
      realizedErrorRate: 0.05,
      realizedMedianFriction: 0.2,
      realizedRevertRate: 0.04,
    });
    expect(out.status).toBe('not_measurable');
  });

  it('marks degraded when error rate or friction rises materially', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineCheapSpendUsd: 50,
      baselineErrorRate: 0.05,
      baselineMedianFriction: 0.2,
      baselineRevertRate: 0.03,
      realizedCheapCalls: 100,
      realizedCheapSpendUsd: 35,
      realizedErrorRate: 0.13,
      realizedMedianFriction: 0.21,
      realizedRevertRate: 0.06,
    });
    expect(out.status).toBe('degraded');
  });

  it('marks improved when savings realized and quality does not degrade', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineCheapSpendUsd: 50,
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      baselineRevertRate: 0.08,
      realizedCheapCalls: 150,
      realizedCheapSpendUsd: 20,
      realizedErrorRate: 0.08,
      realizedMedianFriction: 0.25,
      realizedRevertRate: 0.05,
    });
    expect(out.status).toBe('improved');
    expect(out.realizedSavingUsd).toBe(30);
  });

  it('reports whether the realized saving landed inside the projected range', () => {
    // Projection range is $25–$45; spend fell 50 -> 20, so realized saving is $30.
    const inside = evaluateRoutingProjection(PROJECTION, {
      baselineCheapSpendUsd: 50,
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      baselineRevertRate: 0.08,
      realizedCheapCalls: 150,
      realizedCheapSpendUsd: 20,
      realizedErrorRate: 0.08,
      realizedMedianFriction: 0.25,
      realizedRevertRate: 0.05,
    });
    expect(inside.realizedSavingUsd).toBe(30);
    expect(inside.landedInRange).toBe(true);

    // Spend fell 50 -> 1, so realized saving is $49: better than projected, but
    // the range was still wrong and the flag must say so.
    const above = evaluateRoutingProjection(PROJECTION, {
      baselineCheapSpendUsd: 50,
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      baselineRevertRate: 0.08,
      realizedCheapCalls: 150,
      realizedCheapSpendUsd: 1,
      realizedErrorRate: 0.08,
      realizedMedianFriction: 0.25,
      realizedRevertRate: 0.05,
    });
    expect(above.landedInRange).toBe(false);
    expect(above.status).toBe('improved');
  });

  it('never claims a range hit when the window was not measurable', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineCheapSpendUsd: 50,
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      baselineRevertRate: 0.05,
      realizedCheapCalls: 12,
      realizedCheapSpendUsd: 30,
      realizedErrorRate: 0.05,
      realizedMedianFriction: 0.2,
      realizedRevertRate: 0.04,
    });
    expect(out.status).toBe('not_measurable');
    expect(out.landedInRange).toBe(false);
  });
});
