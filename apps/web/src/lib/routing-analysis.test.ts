import { describe, expect, it } from 'vitest';
import { evaluateRoutingProjection, type RoutingProjectionSnapshot } from './routing-analysis';

const PROJECTION: RoutingProjectionSnapshot = {
  cheapCategories: ['fs_read', 'search'],
  cheapCategoryCalls: 120,
  cheapCategorySpendUsd: 50,
  id: 1n,
  model: 'claude-opus-4-8',
  projectedPeriodSavingUsd: 45,
  projectedWindowDays: 30,
  savingsRatio: 0.9,
  windowEnd: new Date('2026-08-01T00:00:00.000Z'),
  windowStart: new Date('2026-07-02T00:00:00.000Z'),
};

describe('evaluateRoutingProjection', () => {
  it('returns not_measurable below realized-call threshold', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      realizedCheapCalls: 12,
      realizedCheapSpendUsd: 30,
      realizedErrorRate: 0.05,
      realizedMedianFriction: 0.2,
    });
    expect(out.status).toBe('not_measurable');
  });

  it('marks degraded when error rate or friction rises materially', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineErrorRate: 0.05,
      baselineMedianFriction: 0.2,
      realizedCheapCalls: 100,
      realizedCheapSpendUsd: 35,
      realizedErrorRate: 0.13,
      realizedMedianFriction: 0.21,
    });
    expect(out.status).toBe('degraded');
  });

  it('marks improved when savings realized and quality does not degrade', () => {
    const out = evaluateRoutingProjection(PROJECTION, {
      baselineErrorRate: 0.1,
      baselineMedianFriction: 0.3,
      realizedCheapCalls: 150,
      realizedCheapSpendUsd: 20,
      realizedErrorRate: 0.08,
      realizedMedianFriction: 0.25,
    });
    expect(out.status).toBe('improved');
    expect(out.realizedSavingUsd).toBe(30);
  });
});
