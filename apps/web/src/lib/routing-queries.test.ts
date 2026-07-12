import { describe, expect, it } from 'vitest';
import type { OrgModelRoutingRow } from '@/lib/org-queries';
import {
  buildSavingsRatioResolver,
  computeRoutingRecommendations,
  HAIKU_SAVINGS_RATIO,
} from './routing-queries';

describe('buildSavingsRatioResolver', () => {
  const prices = {
    'claude-haiku-4-5': { input_per_mtok: 1 },
    'claude-opus-4-8': { input_per_mtok: 15 },
    'claude-sonnet-4-6': { input_per_mtok: 3 },
  };

  it('derives 1 - haikuRate/premiumRate from the price table', () => {
    const resolver = buildSavingsRatioResolver(prices);
    // opus @ $15 vs haiku @ $1 → 1 - 1/15 ≈ 0.933
    expect(resolver('claude-opus-4-8')).toBeCloseTo(1 - 1 / 15, 5);
  });

  it('caps the ratio at 0.95 even for a very expensive model', () => {
    const resolver = buildSavingsRatioResolver({
      'claude-haiku-4-5': { input_per_mtok: 1 },
      'super-expensive': { input_per_mtok: 1000 },
    });
    expect(resolver('super-expensive')).toBeLessThanOrEqual(0.95);
  });

  it('falls back to the flat heuristic when prices are missing or unusable', () => {
    expect(buildSavingsRatioResolver(null)('claude-opus-4-8')).toBe(HAIKU_SAVINGS_RATIO);
    expect(buildSavingsRatioResolver({})('claude-opus-4-8')).toBe(HAIKU_SAVINGS_RATIO);
    // Unknown model in an otherwise-valid table → heuristic, not NaN.
    expect(buildSavingsRatioResolver(prices)('mystery-model')).toBe(HAIKU_SAVINGS_RATIO);
  });
});

describe('computeRoutingRecommendations', () => {
  const rows: OrgModelRoutingRow[] = [
    { callCount: 100, model: 'claude-opus-4-8', toolCategory: 'fs_read', totalCostUsd: 40 },
    { callCount: 20, model: 'claude-opus-4-8', toolCategory: 'search', totalCostUsd: 10 },
    // Non-premium model + reasoning category are ignored.
    { callCount: 50, model: 'claude-sonnet-4-6', toolCategory: 'fs_read', totalCostUsd: 30 },
    { callCount: 5, model: 'claude-opus-4-8', toolCategory: 'exec', totalCostUsd: 99 },
  ];

  it('applies the resolved per-model ratio and normalizes to 30 days', () => {
    const resolver = buildSavingsRatioResolver({
      'claude-haiku-4-5': { input_per_mtok: 1 },
      'claude-opus-4-8': { input_per_mtok: 15 },
    });
    const { recommendations, estimatedMonthlySaving } = computeRoutingRecommendations(
      rows,
      30,
      resolver,
    );
    expect(recommendations).toHaveLength(1);
    const rec = recommendations[0];
    expect(rec?.model).toBe('claude-opus-4-8');
    // Only fs_read + search count ($50), not exec.
    expect(rec?.cheapCategorySpend).toBe(50);
    const ratio = 1 - 1 / 15;
    expect(rec?.savingsRatio).toBeCloseTo(ratio, 5);
    expect(estimatedMonthlySaving).toBeCloseTo(50 * ratio, 5);
  });

  it('returns nothing when no premium model touched a cheap category', () => {
    const { recommendations } = computeRoutingRecommendations(
      [{ callCount: 50, model: 'claude-sonnet-4-6', toolCategory: 'fs_read', totalCostUsd: 30 }],
      30,
    );
    expect(recommendations).toHaveLength(0);
  });
});
