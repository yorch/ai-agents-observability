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
// at three times today's Opus rate, and `opencode` spans an ~8000x range. This
// file is what fails when a price-table edit silently re-tiers a live model.
//
// The assertions are split deliberately, because the two kinds of price table
// (see AGENTS.md) change for different reasons:
//   - GENERIC invariants (`it.each` over every agent) — monotonicity, tier
//     coverage, well-formed ranges. These hold for `pi`/`omp`/`opencode`, which
//     `bun run gen:price-tables` rewrites wholesale from the models.dev catalog;
//     pinning a specific model's tier there would fail on every regeneration for
//     no useful reason.
//   - SPECIFIC pins — only against the hand-maintained `claude_code` and
//     `copilot` tables, which change by deliberate edit.

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

  it('tiers copilot now that it is token-priced (P14-015)', () => {
    // Copilot's table was empty while it billed premium requests, so it tiered
    // nothing and /org/models could make it no recommendation. GitHub moved
    // Copilot to token-metered AI credits on 2026-06-01 and publishes a per-model
    // rate, so it now tiers like any other agent — and pinning that is what makes
    // the change visible if the table is ever emptied again.
    const tiers = deriveModelTiers(priceTableFor('copilot')?.prices ?? {});
    expect(Object.keys(tiers).length).toBeGreaterThan(20);
    expect(tiers['gpt-5-mini']).toBe('economy');
    expect(tiers['gemini-3.7-flash']).toBe('economy');
    expect(tiers['claude-sonnet-5']).toBe('standard');
    expect(tiers['claude-opus-5']).toBe('premium');
    // All three tiers are populated — a table that collapsed into one tier would
    // still satisfy the pins above if they all moved together.
    expect(new Set(Object.values(tiers)).size).toBe(3);
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
