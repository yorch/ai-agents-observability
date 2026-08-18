import {
  blendedRate,
  deriveModelTiers,
  estimateRoutingSavings,
  MODEL_TIERS,
  type ModelPolicySnapshot,
  type ModelTier,
} from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';
import { pricedAgentTypes, priceTableFor } from '../src/lib/price-tables';

// Golden test over the REAL shipped price tables. Every other model-policy test
// runs on hand-built fixtures, which means they validate a world we chose rather
// than the one we ship — and the two differ: `claude_code` retains retired rows
// at three times today's Opus rate, and `opencode` spans a ~225x range. This
// file is what fails when a price-table edit silently re-tiers a live model.

const TIER_RANK: Record<ModelTier, number> = { economy: 0, premium: 2, standard: 1 };

function snapshotFor(agentKey: string): ModelPolicySnapshot {
  const prices = priceTableFor(agentKey)?.prices ?? {};
  return {
    agentType: agentKey.toUpperCase(),
    allowedModels: [],
    cheapCategories: ['fs_read', 'search'],
    inputRates: Object.fromEntries(Object.entries(prices).map(([m, p]) => [m, p.input_per_mtok])),
    tiers: deriveModelTiers(prices),
  };
}

describe('model policy against the shipped price tables', () => {
  it.each(pricedAgentTypes())('%s: tiers every priced model and nothing else', (agentKey) => {
    const prices = priceTableFor(agentKey)?.prices ?? {};
    const tiers = deriveModelTiers(prices);
    const priced = Object.entries(prices)
      .filter(([, p]) => blendedRate(p) > 0)
      .map(([m]) => m);
    expect(Object.keys(tiers).sort()).toEqual(priced.sort());
    for (const tier of Object.values(tiers)) {
      expect(MODEL_TIERS).toContain(tier);
    }
  });

  it.each(pricedAgentTypes())('%s: tiering is monotone in blended rate', (agentKey) => {
    const prices = priceTableFor(agentKey)?.prices ?? {};
    const tiers = deriveModelTiers(prices);
    for (const [a, pa] of Object.entries(prices)) {
      for (const [b, pb] of Object.entries(prices)) {
        const ta = tiers[a];
        const tb = tiers[b];
        if (!ta || !tb || blendedRate(pa) >= blendedRate(pb)) {
          continue;
        }
        // Cheaper model must never sit in a dearer tier.
        expect(TIER_RANK[ta]).toBeLessThanOrEqual(TIER_RANK[tb]);
      }
    }
  });

  it.each(pricedAgentTypes())('%s: every savings range is well-formed', (agentKey) => {
    const policy = snapshotFor(agentKey);
    for (const model of Object.keys(policy.tiers)) {
      const out = estimateRoutingSavings(policy, model);
      if (out === null) {
        continue;
      }
      expect(out.low).toBeGreaterThanOrEqual(0);
      expect(out.high).toBeGreaterThanOrEqual(out.low);
      expect(out.high).toBeLessThanOrEqual(0.95);
      // The named target must genuinely be cheaper than the model it replaces.
      expect(policy.inputRates[out.bestTargetModel] as number).toBeLessThan(
        policy.inputRates[model] as number,
      );
      expect(TIER_RANK[out.targetTier]).toBeLessThan(TIER_RANK[policy.tiers[model] as ModelTier]);
    }
  });

  it('copilot ships an intentionally empty table and tiers nothing', () => {
    // Copilot bills a seat allowance, not tokens. Empty must mean "unpriced",
    // never "everything is the cheapest model".
    expect(deriveModelTiers(priceTableFor('copilot')?.prices ?? {})).toEqual({});
  });

  it('pins the tier of the models the product actually reasons about', () => {
    const claude = deriveModelTiers(priceTableFor('claude_code')?.prices ?? {});
    // These are asserted so a price-table edit that moves them is visible in a
    // diff rather than silently changing what /org/models recommends.
    expect(claude['claude-haiku-4-5']).toBe('economy');
    expect(claude['claude-sonnet-5']).toBe('standard');
    // Current Opus sits in `standard`, NOT `premium` — the table retains
    // retired Opus rows at $15/$75 which occupy the top band. The routing
    // recommendation still fires for it (economy is cheaper), so this is a
    // labelling artifact, and it is exactly what an admin tier override exists
    // to correct.
    expect(claude['claude-opus-5']).toBe('standard');
  });

  it('names a concrete downgrade target for current Opus retrieval work', () => {
    const policy = snapshotFor('claude_code');
    const out = estimateRoutingSavings(policy, 'claude-opus-5');
    expect(out).not.toBeNull();
    expect(out?.targetTier).toBe('economy');
    // KNOWN LIMITATION, pinned deliberately: the cheapest economy row is a 2024
    // model the tables keep for historical cost recompute, so it can surface as
    // the suggested target. Recommending a retired model is a real wart —
    // tracked in P10-001 (the price tables need a deprecation flag). The test
    // asserts today's behaviour so the fix is a visible diff, not a surprise.
    expect(out?.bestTargetModel).toBe('claude-3-5-haiku-20241022');
  });
});
