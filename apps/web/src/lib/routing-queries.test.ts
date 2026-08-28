import { deriveModelTiers, type ModelPolicySnapshot } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';
import type { OrgModelRoutingRow } from './org-queries';
import {
  computeRoutingRecommendations,
  MIN_ROUTING_CHEAP_CALLS,
  MIN_ROUTING_CHEAP_SPEND_USD,
} from './routing-queries';

function price(input: number, output: number) {
  return {
    cache_read_per_mtok: input / 10,
    cache_write_per_mtok: input * 1.25,
    input_per_mtok: input,
    output_per_mtok: output,
  };
}

function policyFor(
  agentType: string,
  prices: Record<string, ReturnType<typeof price>>,
): ModelPolicySnapshot {
  return {
    agentType,
    allowedModels: [],
    cheapCategories: ['fs_read', 'search'],
    inputRates: Object.fromEntries(Object.entries(prices).map(([m, p]) => [m, p.input_per_mtok])),
    tiers: deriveModelTiers(prices),
  };
}

const CLAUDE = policyFor('CLAUDE_CODE', {
  'claude-haiku-4-5': price(1, 5),
  'claude-opus-4-1': price(15, 75),
  'claude-opus-5': price(5, 25),
  'claude-sonnet-5': price(2, 10),
});

const GEMINI = policyFor('GEMINI_CLI', {
  'gemini-2.5-flash': price(0.3, 2.5),
  'gemini-2.5-pro': price(1.25, 10),
  'gemini-3.1-pro-preview': price(2, 12),
});

const POLICIES = new Map([
  ['CLAUDE_CODE', CLAUDE],
  ['GEMINI_CLI', GEMINI],
]);

function row(over: Partial<OrgModelRoutingRow> = {}): OrgModelRoutingRow {
  return {
    agentType: 'CLAUDE_CODE',
    attributedCostUsd: 50,
    callCount: 120,
    model: 'claude-opus-4-1',
    toolCategory: 'fs_read',
    ...over,
  };
}

describe('computeRoutingRecommendations', () => {
  it('pins the saving arithmetic to exact figures', () => {
    // claude-opus-4-1 input $15, $50 of retrieval spend over 30 days. Retrieval
    // targets the economy tier: claude-haiku-4-5 at $1.
    const { recommendations } = computeRoutingRecommendations([row()], 30, POLICIES);
    const rec = recommendations[0];
    expect(rec?.model).toBe('claude-opus-4-1');
    expect(rec?.tier).toBe('premium');
    expect(rec?.targetTier).toBe('economy');
    expect(rec?.exampleTargetModel).toBe('claude-haiku-4-5');
    expect(rec?.monthlySavingHigh).toBeCloseTo(50 * (1 - 1 / 15), 5);
    expect(rec?.monthlySavingLow).toBeCloseTo(50 * (1 - 1 / 15), 5);
  });

  it('pins the monthly normalisation to a number, not an inequality', () => {
    const week = computeRoutingRecommendations([row()], 7, POLICIES);
    // Same $50 over 7 days projects to 30/7 as much per month.
    expect(week.recommendations[0]?.monthlySavingHigh).toBeCloseTo(50 * (1 - 1 / 15) * (30 / 7), 5);
  });

  it('suppresses a downgrade whose best case saves less than the floor', () => {
    const marginal = new Map([
      [
        'CLAUDE_CODE',
        {
          agentType: 'CLAUDE_CODE',
          allowedModels: [],
          cheapCategories: ['fs_read'],
          inputRates: { dear: 1.2, near: 1 },
          tiers: { dear: 'premium' as const, near: 'economy' as const },
        },
      ],
    ]);
    // 1 - 1/1.2 = 0.167, under MIN_SAVINGS_RATIO (0.25).
    const out = computeRoutingRecommendations([row({ model: 'dear' })], 30, marginal);
    expect(out.recommendations).toHaveLength(0);
    expect(out.unpricedModels).toHaveLength(0);
  });

  it('reports confidence from the spend and call thresholds together', () => {
    const high = computeRoutingRecommendations(
      [row({ attributedCostUsd: 50, callCount: 120 })],
      30,
      POLICIES,
    );
    expect(high.recommendations[0]?.confidence).toBe('high');
    const fewCalls = computeRoutingRecommendations(
      [row({ attributedCostUsd: 50, callCount: 99 })],
      30,
      POLICIES,
    );
    expect(fewCalls.recommendations[0]?.confidence).toBe('medium');
    const lowSpend = computeRoutingRecommendations(
      [row({ attributedCostUsd: 19, callCount: 120 })],
      30,
      POLICIES,
    );
    expect(lowSpend.recommendations[0]?.confidence).toBe('medium');
  });

  it('orders top categories by spend, since that array is persisted and rendered', () => {
    const { recommendations } = computeRoutingRecommendations(
      [
        row({ attributedCostUsd: 10, callCount: 60, toolCategory: 'fs_read' }),
        row({ attributedCostUsd: 40, callCount: 60, toolCategory: 'search' }),
      ],
      30,
      POLICIES,
    );
    expect(recommendations[0]?.topCategories.map((c) => c.category)).toEqual(['search', 'fs_read']);
  });

  it('keeps two agents pricing the same model id apart', () => {
    const shared = new Map(POLICIES);
    const { recommendations } = computeRoutingRecommendations(
      [
        row({ agentType: 'CLAUDE_CODE', model: 'claude-opus-4-1' }),
        row({ agentType: 'GEMINI_CLI', model: 'gemini-3.1-pro-preview' }),
      ],
      30,
      shared,
    );
    expect(recommendations).toHaveLength(2);
    const byAgent = new Map(recommendations.map((r) => [r.agentType, r]));
    // Each resolves its target from its OWN table — never the other's.
    expect(byAgent.get('CLAUDE_CODE')?.exampleTargetModel).toMatch(/^claude-/);
    expect(byAgent.get('GEMINI_CLI')?.exampleTargetModel).toMatch(/^gemini-/);
  });

  it('counts only the policy cheap categories', () => {
    const { recommendations } = computeRoutingRecommendations(
      [
        row({ attributedCostUsd: 40, callCount: 100, toolCategory: 'fs_read' }),
        row({ attributedCostUsd: 10, callCount: 100, toolCategory: 'search' }),
        row({ attributedCostUsd: 900, callCount: 900, toolCategory: 'exec' }),
      ],
      30,
      POLICIES,
    );
    expect(recommendations[0]?.cheapCategorySpend).toBe(50);
    expect(recommendations[0]?.cheapCategoryCalls).toBe(200);
  });

  it('suppresses rows under the call or spend floor', () => {
    const thinCalls = computeRoutingRecommendations(
      [row({ attributedCostUsd: 500, callCount: MIN_ROUTING_CHEAP_CALLS - 1 })],
      30,
      POLICIES,
    );
    expect(thinCalls.recommendations).toHaveLength(0);

    const thinSpend = computeRoutingRecommendations(
      [row({ attributedCostUsd: MIN_ROUTING_CHEAP_SPEND_USD - 0.01, callCount: 5000 })],
      30,
      POLICIES,
    );
    expect(thinSpend.recommendations).toHaveLength(0);

    // Suppressed, but not discarded: the empty state has to be able to tell
    // "too little spend to judge" from "nothing downgradeable ran at all".
    expect(thinCalls.belowConfidenceThreshold).toHaveLength(1);
    expect(thinSpend.belowConfidenceThreshold).toHaveLength(1);
    expect(thinSpend.belowConfidenceThreshold[0]?.spendUsd).toBe(
      MIN_ROUTING_CHEAP_SPEND_USD - 0.01,
    );
  });

  it('separates "nothing downgradeable" from "suppressed as low-confidence"', () => {
    // No rows at all: the genuinely-efficient case. Nothing to report either way.
    const empty = computeRoutingRecommendations([], 30, POLICIES);
    expect(empty.recommendations).toHaveLength(0);
    expect(empty.belowConfidenceThreshold).toHaveLength(0);

    // A row that clears both floors is a recommendation, not a suppression —
    // otherwise the two lists could both be non-empty and the copy would lie.
    const strong = computeRoutingRecommendations(
      [row({ attributedCostUsd: 50, callCount: 200 })],
      30,
      POLICIES,
    );
    expect(strong.recommendations.length).toBeGreaterThan(0);
    expect(strong.belowConfidenceThreshold).toHaveLength(0);
  });

  it('does not report unattributable spend as low-confidence', () => {
    // A null spend is "we cannot attribute these calls", which the page's
    // CostAttributionNote already explains. Counting it here would blame the
    // routing thresholds for a coverage gap.
    const unattributed = computeRoutingRecommendations(
      [row({ attributedCostUsd: null, callCount: 5000 })],
      30,
      POLICIES,
    );
    expect(unattributed.recommendations).toHaveLength(0);
    expect(unattributed.belowConfidenceThreshold).toHaveLength(0);
  });

  it('fires for a non-Anthropic agent, which the opus-substring rule never could', () => {
    const { recommendations } = computeRoutingRecommendations(
      [row({ agentType: 'GEMINI_CLI', model: 'gemini-3.1-pro-preview' })],
      30,
      POLICIES,
    );
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.agentType).toBe('GEMINI_CLI');
  });

  it('never routes across agents — a gemini model is priced by gemini only', () => {
    // Same model id, two agents: each must resolve against its own policy.
    const { recommendations, unpricedModels } = computeRoutingRecommendations(
      [row({ agentType: 'GEMINI_CLI', model: 'claude-opus-4-1' })],
      30,
      POLICIES,
    );
    expect(recommendations).toHaveLength(0);
    expect(unpricedModels).toEqual([{ agentType: 'GEMINI_CLI', model: 'claude-opus-4-1' }]);
  });

  it('reports material spend on an unpriced model instead of silently dropping it', () => {
    const { recommendations, unpricedModels } = computeRoutingRecommendations(
      [row({ model: 'some-unlisted-model' })],
      30,
      POLICIES,
    );
    expect(recommendations).toHaveLength(0);
    expect(unpricedModels).toEqual([{ agentType: 'CLAUDE_CODE', model: 'some-unlisted-model' }]);
  });

  it('makes no recommendation for the cheapest tier — there is nothing to route to', () => {
    const { recommendations, unpricedModels } = computeRoutingRecommendations(
      [row({ model: 'claude-haiku-4-5' })],
      30,
      POLICIES,
    );
    expect(recommendations).toHaveLength(0);
    // Not "unpriced" — it is priced, it simply has no cheaper target.
    expect(unpricedModels).toHaveLength(0);
  });

  it('drops a row whose agent has no resolved policy', () => {
    const { recommendations } = computeRoutingRecommendations(
      [row({ agentType: 'UNKNOWN_AGENT' })],
      30,
      POLICIES,
    );
    expect(recommendations).toHaveLength(0);
  });

  it('normalises the range to a month', () => {
    const week = computeRoutingRecommendations([row()], 7, POLICIES);
    const month = computeRoutingRecommendations([row()], 30, POLICIES);
    // Same spend over a shorter window projects to more per month.
    expect(week.estimatedMonthlySavingHigh).toBeGreaterThan(month.estimatedMonthlySavingHigh);
  });

  it('totals the org range across recommendations', () => {
    const { estimatedMonthlySavingHigh, estimatedMonthlySavingLow, recommendations } =
      computeRoutingRecommendations(
        [row(), row({ agentType: 'GEMINI_CLI', model: 'gemini-3.1-pro-preview' })],
        30,
        POLICIES,
      );
    expect(recommendations).toHaveLength(2);
    expect(estimatedMonthlySavingHigh).toBeCloseTo(
      recommendations.reduce((s, r) => s + r.monthlySavingHigh, 0),
      6,
    );
    expect(estimatedMonthlySavingLow).toBeLessThanOrEqual(estimatedMonthlySavingHigh);
  });
});
