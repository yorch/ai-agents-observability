import type { OrgModelRoutingRow } from '@/lib/org-queries';

// Pure recommendation logic layered on top of getOrgModelRoutingBreakdown's
// already-visibility-scoped rows (see org-queries.ts). No DB/network access here —
// the caller fetches the price table and passes a resolver in, so this stays
// trivially testable and free of its own visibility concerns.

// Model ids containing this substring (case-insensitive) are treated as
// premium-tier. `sonnet` is deliberately excluded — it's "mid", not premium.
// Exported so the raw-SQL routing surfaces (getRoutingSpendByTeam) source the
// policy from here instead of re-hardcoding it. NOTE: the ingest routing_waste
// alert (evaluate-alerts.ts) is a separate app and mirrors the same policy.
export const PREMIUM_PATTERN = 'opus';

// Tool categories that are pure retrieval — no hard reasoning required, so a
// Haiku-class model is a safe downgrade target. Conservative on purpose:
// `exec` is debatable (tool calls can gate on reasoning) so it's left out.
export const CHEAP_SUITABLE_CATEGORIES = new Set(['fs_read', 'search']);

// Fallback fraction saved when no price table is available (INGEST_URL unset, or
// the model/target is missing rates). Directional only. When prices ARE present,
// a per-model ratio is derived from them instead (buildSavingsRatioResolver).
export const HAIKU_SAVINGS_RATIO = 0.9;

// Never claim more than this even when raw price math implies it — keeps the
// estimate honest given retrieval turns still carry some irreducible cost.
const MAX_SAVINGS_RATIO = 0.95;

/** Per-model input price ($/Mtok) — the subset of the price table we need. */
export type ModelInputPrice = { input_per_mtok: number };

/** Resolves the estimated saved fraction of a premium model's retrieval spend. */
export type SavingsRatioResolver = (model: string) => number;

// Builds a price-derived savings resolver: for a premium model priced at
// `premiumRate` $/Mtok input, routing retrieval turns to the cheapest Haiku-class
// model (`targetRate`) saves `1 - targetRate/premiumRate` of that spend. Input
// rate is the basis because retrieval turns are input-dominated. Falls back to the
// flat HAIKU_SAVINGS_RATIO when prices are missing so the surface degrades cleanly.
export function buildSavingsRatioResolver(
  prices: Record<string, ModelInputPrice> | null | undefined,
): SavingsRatioResolver {
  const entries = Object.entries(prices ?? {}).filter(([, p]) => p.input_per_mtok > 0);
  if (entries.length === 0) {
    return () => HAIKU_SAVINGS_RATIO;
  }
  const haiku = entries.filter(([m]) => m.toLowerCase().includes('haiku'));
  const pool = haiku.length > 0 ? haiku : entries;
  const targetRate = Math.min(...pool.map(([, p]) => p.input_per_mtok));
  return (model: string) => {
    const rate = prices?.[model]?.input_per_mtok;
    if (!rate || rate <= 0 || rate <= targetRate) {
      return HAIKU_SAVINGS_RATIO;
    }
    return Math.max(0, Math.min(MAX_SAVINGS_RATIO, 1 - targetRate / rate));
  };
}

export type RoutingRecommendation = {
  cheapCategorySpend: number;
  estimatedMonthlySaving: number;
  model: string;
  // The saved fraction applied (price-derived when a table was supplied, else the
  // flat fallback) — surfaced so the UI can show "~72% cheaper", not a fixed 90%.
  savingsRatio: number;
  topCategories: { callCount: number; category: string; costUsd: number }[];
};

function isPremiumModel(model: string): boolean {
  return model.toLowerCase().includes(PREMIUM_PATTERN);
}

export function computeRoutingRecommendations(
  rows: OrgModelRoutingRow[],
  rangeDays: number,
  savingsRatioFor: SavingsRatioResolver = () => HAIKU_SAVINGS_RATIO,
): { estimatedMonthlySaving: number; recommendations: RoutingRecommendation[] } {
  const cheapRowsByModel = new Map<string, OrgModelRoutingRow[]>();
  for (const row of rows) {
    if (!isPremiumModel(row.model) || !CHEAP_SUITABLE_CATEGORIES.has(row.toolCategory)) {
      continue;
    }
    const existing = cheapRowsByModel.get(row.model);
    if (existing) {
      existing.push(row);
    } else {
      cheapRowsByModel.set(row.model, [row]);
    }
  }

  const normalizeToMonthly = rangeDays > 0 ? 30 / rangeDays : 0;
  const recommendations: RoutingRecommendation[] = [];
  for (const [model, modelRows] of cheapRowsByModel) {
    const cheapCategorySpend = modelRows.reduce((sum, r) => sum + r.totalCostUsd, 0);
    if (cheapCategorySpend <= 0) {
      continue;
    }
    const savingsRatio = savingsRatioFor(model);
    const topCategories = modelRows
      .map((r) => ({ callCount: r.callCount, category: r.toolCategory, costUsd: r.totalCostUsd }))
      .sort((a, b) => b.costUsd - a.costUsd);
    recommendations.push({
      cheapCategorySpend,
      estimatedMonthlySaving: cheapCategorySpend * savingsRatio * normalizeToMonthly,
      model,
      savingsRatio,
      topCategories,
    });
  }
  recommendations.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);

  const estimatedMonthlySaving = recommendations.reduce(
    (sum, r) => sum + r.estimatedMonthlySaving,
    0,
  );
  return { estimatedMonthlySaving, recommendations };
}
