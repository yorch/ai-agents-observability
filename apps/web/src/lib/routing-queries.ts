import {
  DEFAULT_CHEAP_CATEGORIES,
  estimateRoutingSavings,
  isCheapCategory,
  MIN_SAVINGS_RATIO,
  type ModelPolicySnapshot,
  type ModelTier,
  resolveModelTier,
  type SavingsRange,
} from '@ai-agents-observability/schemas';
import type { OrgModelRoutingRow } from '@/lib/org-queries';

// Pure recommendation logic layered on top of getOrgModelRoutingBreakdown's
// already-visibility-scoped rows (see org-queries.ts). No DB/network access here —
// the caller resolves each agent's policy and passes it in, so this stays
// trivially testable and free of its own visibility concerns.
//
// Everything that used to be a hardcoded Anthropic assumption (`PREMIUM_PATTERN
// = 'opus'`, a flat 0.9 savings ratio, a page-local cheap-category set) now
// comes from the per-agent policy in packages/schemas/src/model-policy.ts,
// which apps/ingest reads too.

/**
 * The default retrieval-only categories, as a set, for the one raw-SQL surface
 * that cannot resolve a per-agent policy inside its aggregate: `getRoutingActuals`
 * in projection-queries.ts measures a single model over a single window and has
 * no agent in hand. Re-exported from the shared policy defaults rather than
 * restated, so a projection and the recommendation it checks can never disagree
 * about what "retrieval-only" means.
 */
export const CHEAP_SUITABLE_CATEGORIES: ReadonlySet<string> = new Set(DEFAULT_CHEAP_CATEGORIES);

// Recommendation evidence gates (P10): avoid seductive point estimates from a
// tiny call/spend sample. Rows below either threshold are suppressed.
export const MIN_ROUTING_CHEAP_CALLS = 25;
export const MIN_ROUTING_CHEAP_SPEND_USD = 5;

// Above these a recommendation is called high-confidence rather than medium.
const HIGH_CONFIDENCE_SPEND_USD = 20;
const HIGH_CONFIDENCE_CALLS = 100;

export type RoutingRecommendation = {
  agentType: string;
  cheapCategoryCalls: number;
  cheapCategorySpend: number;
  confidence: 'high' | 'medium';
  /** Cheapest model in the target tier — what the best case assumes. */
  exampleTargetModel: string;
  /**
   * Monthly saving as a RANGE, never a point estimate. The target tier holds
   * several models at different rates, so what a team actually saves depends on
   * which one it picks (DESIGN_DOC §10.6).
   */
  monthlySavingHigh: number;
  monthlySavingLow: number;
  model: string;
  targetTier: ModelTier;
  tier: ModelTier;
  topCategories: { callCount: number; category: string; costUsd: number }[];
};

type Grouped = {
  agentType: string;
  calls: number;
  model: string;
  rows: OrgModelRoutingRow[];
  spend: number;
};

/**
 * Build routing recommendations across every agent present in `rows`.
 *
 * `policies` is keyed by `agent_type`. A row whose agent has no policy — or
 * whose model has no price entry, or no cheaper tier to route to — produces no
 * recommendation at all rather than a fabricated one, which is the
 * `savings: null` requirement in P10-001 expressed as an omission.
 */
export function computeRoutingRecommendations(
  rows: OrgModelRoutingRow[],
  rangeDays: number,
  policies: Map<string, ModelPolicySnapshot>,
): {
  estimatedMonthlySavingHigh: number;
  estimatedMonthlySavingLow: number;
  recommendations: RoutingRecommendation[];
  /** Models that carried cheap-category spend but could not be priced. */
  unpricedModels: { agentType: string; model: string }[];
} {
  // Group by (agent_type, model): the same model id under two agents is two
  // different economic objects, priced from two different tables.
  const grouped = new Map<string, Grouped>();
  for (const row of rows) {
    const policy = policies.get(row.agentType);
    if (!policy || !isCheapCategory(policy, row.toolCategory)) {
      continue;
    }
    const key = `${row.agentType}:${row.model}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.calls += row.callCount;
      existing.spend += row.totalCostUsd;
      existing.rows.push(row);
    } else {
      grouped.set(key, {
        agentType: row.agentType,
        calls: row.callCount,
        model: row.model,
        rows: [row],
        spend: row.totalCostUsd,
      });
    }
  }

  const normalizeToMonthly = rangeDays > 0 ? 30 / rangeDays : 0;
  const recommendations: RoutingRecommendation[] = [];
  const unpricedModels: { agentType: string; model: string }[] = [];

  for (const group of grouped.values()) {
    if (group.spend < MIN_ROUTING_CHEAP_SPEND_USD || group.calls < MIN_ROUTING_CHEAP_CALLS) {
      continue;
    }
    const policy = policies.get(group.agentType);
    if (!policy) {
      continue;
    }

    const tier = resolveModelTier(policy, group.model);
    // "Unpriced" and "nothing cheaper to route to" both yield no recommendation
    // but mean opposite things, and only the first is a gap worth reporting.
    // Conflating them would list every economy-tier model as unpriced.
    const rate = policy.inputRates[group.model];
    if (tier === null || rate === undefined || rate <= 0) {
      // Material spend on a model we cannot price is worth surfacing — silently
      // dropping it would read as "routing is already efficient".
      unpricedModels.push({ agentType: group.agentType, model: group.model });
      continue;
    }
    const savings: SavingsRange | null = estimateRoutingSavings(policy, group.model);
    if (savings === null) {
      // Priced, but already on the cheapest tier its agent offers.
      continue;
    }
    // A downgrade that saves a rounding error is not worth the behaviour change.
    if (savings.high < MIN_SAVINGS_RATIO) {
      continue;
    }

    const topCategories = group.rows
      .map((r) => ({ callCount: r.callCount, category: r.toolCategory, costUsd: r.totalCostUsd }))
      .sort((a, b) => b.costUsd - a.costUsd);

    recommendations.push({
      agentType: group.agentType,
      cheapCategoryCalls: group.calls,
      cheapCategorySpend: group.spend,
      confidence:
        group.spend >= HIGH_CONFIDENCE_SPEND_USD && group.calls >= HIGH_CONFIDENCE_CALLS
          ? 'high'
          : 'medium',
      exampleTargetModel: savings.bestTargetModel,
      model: group.model,
      monthlySavingHigh: group.spend * savings.high * normalizeToMonthly,
      monthlySavingLow: group.spend * savings.low * normalizeToMonthly,
      targetTier: savings.targetTier,
      tier,
      topCategories,
    });
  }

  recommendations.sort((a, b) => b.monthlySavingHigh - a.monthlySavingHigh);

  return {
    estimatedMonthlySavingHigh: recommendations.reduce((s, r) => s + r.monthlySavingHigh, 0),
    estimatedMonthlySavingLow: recommendations.reduce((s, r) => s + r.monthlySavingLow, 0),
    recommendations,
    unpricedModels,
  };
}

/**
 * Fraction of the best case that the *low* end of a registered routing claim may
 * never exceed (P13-006).
 *
 * The price-derived range spans target-model choice only: `low` prices the
 * dearest model in the target tier, `high` the cheapest. When that tier holds a
 * single priced model the two collapse into one number — and a projection
 * registered as `low === high` asserts a precision the data cannot support. This
 * floor is the *other* source of uncertainty the price ratio cannot see: real
 * routing leaves some turns on the premium model and pays for the occasional
 * retry. It caps the low end rather than replacing it, so a genuinely wide
 * price-derived range is still reported as measured.
 */
