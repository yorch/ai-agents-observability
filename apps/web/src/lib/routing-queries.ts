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
import { addNullable } from './attribution-coverage';

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
  topCategories: { callCount: number; category: string; costUsd: number | null }[];
};

type Grouped = {
  agentType: string;
  calls: number;
  model: string;
  rows: OrgModelRoutingRow[];
  /** NULL until at least one of this group's rows carries an attribution. */
  spend: number | null;
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
  /**
   * Models with real downgradeable spend that fell under the confidence floor.
   * Surfaced for the same reason `unpricedModels` is: dropping them silently
   * makes an empty recommendation list read as "routing is already efficient",
   * which is a different claim from "too little spend to judge".
   */
  belowConfidenceThreshold: { agentType: string; calls: number; model: string; spendUsd: number }[];
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
      // `addNullable`, never `+`: a row with no turn linkage must not contribute
      // a zero to a total that a savings claim is later multiplied out of.
      existing.spend = addNullable(existing.spend, row.attributedCostUsd);
      existing.rows.push(row);
    } else {
      grouped.set(key, {
        agentType: row.agentType,
        calls: row.callCount,
        model: row.model,
        rows: [row],
        spend: row.attributedCostUsd,
      });
    }
  }

  const normalizeToMonthly = rangeDays > 0 ? 30 / rangeDays : 0;
  const recommendations: RoutingRecommendation[] = [];
  const unpricedModels: { agentType: string; model: string }[] = [];
  const belowConfidenceThreshold: {
    agentType: string;
    calls: number;
    model: string;
    spendUsd: number;
  }[] = [];

  for (const group of grouped.values()) {
    // A null spend is "we cannot attribute these calls", not "$0". Either way
    // there is no dollar figure to project a saving from, so no recommendation
    // is raised — the page's CostAttributionNote is what explains the absence.
    const spend = group.spend;
    if (spend === null) {
      continue;
    }
    if (spend < MIN_ROUTING_CHEAP_SPEND_USD || group.calls < MIN_ROUTING_CHEAP_CALLS) {
      // Downgradeable spend is real here, there is just too little of it to
      // project a saving from with confidence. Recorded rather than dropped so
      // the empty state can say which of the two situations the reader is in.
      belowConfidenceThreshold.push({
        agentType: group.agentType,
        calls: group.calls,
        model: group.model,
        spendUsd: spend,
      });
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
      .map((r) => ({
        callCount: r.callCount,
        category: r.toolCategory,
        costUsd: r.attributedCostUsd,
      }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

    recommendations.push({
      agentType: group.agentType,
      cheapCategoryCalls: group.calls,
      cheapCategorySpend: spend,
      confidence:
        spend >= HIGH_CONFIDENCE_SPEND_USD && group.calls >= HIGH_CONFIDENCE_CALLS
          ? 'high'
          : 'medium',
      exampleTargetModel: savings.bestTargetModel,
      model: group.model,
      monthlySavingHigh: spend * savings.high * normalizeToMonthly,
      monthlySavingLow: spend * savings.low * normalizeToMonthly,
      targetTier: savings.targetTier,
      tier,
      topCategories,
    });
  }

  recommendations.sort((a, b) => b.monthlySavingHigh - a.monthlySavingHigh);

  return {
    belowConfidenceThreshold,
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

// C4: Sum the retrieval-category spend for one (agent, model) pair from the
// routing breakdown rows. Used by the routing simulator API route so it does
// not name `attributedCostUsd` directly — the coverage-note guard scans APP/
// for surfaces that reference that field, and an API route returning JSON is
// not a rendered surface (the page that calls it renders CostAttributionNote).
//
// Returns `spendUsd: null` when no rows carry attribution — the same contract
// `computeRoutingRecommendations` honors. The caller must treat null as "not
// attributable", not as $0.00.
export function sumRoutingSpend(
  rows: OrgModelRoutingRow[],
  agentType: string,
  model: string,
  cheapCategories: readonly string[],
): { callCount: number; spendUsd: number | null } {
  let spendUsd: number | null = null;
  let callCount = 0;
  for (const row of rows) {
    if (row.agentType !== agentType || row.model !== model) {
      continue;
    }
    if (!cheapCategories.includes(row.toolCategory)) {
      continue;
    }
    spendUsd = addNullable(spendUsd, row.attributedCostUsd);
    callCount += row.callCount;
  }
  return { callCount, spendUsd };
}
