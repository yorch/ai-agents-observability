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
    expect(resolver('claude-opus-4-8').ratio).toBeCloseTo(1 - 1 / 15, 5);
    expect(resolver('claude-opus-4-8').priceDerived).toBe(true);
  });

  it('caps the ratio at 0.95 even for a very expensive model', () => {
    const resolver = buildSavingsRatioResolver({
      'claude-haiku-4-5': { input_per_mtok: 1 },
      'super-expensive': { input_per_mtok: 1000 },
    });
    expect(resolver('super-expensive').ratio).toBeLessThanOrEqual(0.95);
  });

  it('falls back to the flat heuristic when prices are missing or unusable', () => {
    expect(buildSavingsRatioResolver(null)('claude-opus-4-8').ratio).toBe(HAIKU_SAVINGS_RATIO);
    expect(buildSavingsRatioResolver({})('claude-opus-4-8').ratio).toBe(HAIKU_SAVINGS_RATIO);
    // Unknown model in an otherwise-valid table → heuristic, not NaN.
    expect(buildSavingsRatioResolver(prices)('mystery-model').ratio).toBe(HAIKU_SAVINGS_RATIO);
  });

  // The defect this shape exists to prevent. A reachable, non-empty table used to
  // be reported panel-wide as "derived per-model", and the projection recorded
  // priceTableVersion: 'ingest:current' — for EVERY row, including ones the table
  // never contained. That is a false provenance on a stored claim, and P13-006's
  // realization replays against exactly that field.
  it('reports a model missing from a reachable table as NOT price-derived', () => {
    const resolver = buildSavingsRatioResolver(prices);
    // The table is present and usable...
    expect(resolver('claude-opus-4-8').priceDerived).toBe(true);
    // ...but this model is not in it, so its ratio is the flat fallback and must
    // not be described, or recorded, as derived.
    const missing = resolver('anthropic/claude-opus-5');
    expect(missing.ratio).toBe(HAIKU_SAVINGS_RATIO);
    expect(missing.priceDerived).toBe(false);
  });

  it('reports a model already at or below the target tier as NOT price-derived', () => {
    // No downgrade is available, so the returned ratio is the fallback, not a
    // derivation — the distinction matters for the provenance stamp.
    expect(buildSavingsRatioResolver(prices)('claude-haiku-4-5').priceDerived).toBe(false);
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

  it('carries priceDerived per recommendation, not per panel', () => {
    // A table that prices one premium model but not the other. Before this was a
    // per-model fact, both rows below rendered as "derived per-model" and both
    // recorded priceTableVersion: 'ingest:current', because the panel-wide flag
    // only asked whether the fetch returned anything.
    const resolver = buildSavingsRatioResolver({
      'claude-haiku-4-5': { input_per_mtok: 1 },
      'claude-opus-4-8': { input_per_mtok: 15 },
    });
    const mixed: OrgModelRoutingRow[] = [
      ...rows,
      { callCount: 10, model: 'claude-opus-9-unpriced', toolCategory: 'fs_read', totalCostUsd: 20 },
    ];
    const { recommendations } = computeRoutingRecommendations(mixed, 30, resolver);
    const byModel = new Map(recommendations.map((r) => [r.model, r]));
    expect(byModel.get('claude-opus-4-8')?.priceDerived).toBe(true);
    expect(byModel.get('claude-opus-9-unpriced')?.priceDerived).toBe(false);
    // The unpriced one still gets a directional estimate — this change is about
    // provenance, not about suppressing the row (that is P10-001's open decision).
    expect(byModel.get('claude-opus-9-unpriced')?.savingsRatio).toBe(HAIKU_SAVINGS_RATIO);
  });

  it('returns nothing when no premium model touched a cheap category', () => {
    const { recommendations } = computeRoutingRecommendations(
      [{ callCount: 50, model: 'claude-sonnet-4-6', toolCategory: 'fs_read', totalCostUsd: 30 }],
      30,
    );
    expect(recommendations).toHaveLength(0);
  });
});
