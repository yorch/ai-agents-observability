import type { OrgModelRoutingRow } from '@/lib/org-queries';

// Pure recommendation logic layered on top of getOrgModelRoutingBreakdown's
// already-visibility-scoped rows (see org-queries.ts). No DB access here —
// keep it trivially testable and free of its own visibility concerns.

// Model ids containing this substring (case-insensitive) are treated as
// premium-tier. `sonnet` is deliberately excluded — it's "mid", not premium.
const PREMIUM_PATTERN = 'opus';

// Tool categories that are pure retrieval — no hard reasoning required, so a
// Haiku-class model is a safe downgrade target. Conservative on purpose:
// `exec` is debatable (tool calls can gate on reasoning) so it's left out.
const CHEAP_SUITABLE_CATEGORIES = new Set(['fs_read', 'search']);

// Routing an Opus-priced turn to a Haiku-class model saves roughly this
// fraction of that turn's model cost. Directional only — validate against
// your actual price table before acting on it.
export const HAIKU_SAVINGS_RATIO = 0.9;

export type RoutingRecommendation = {
  cheapCategorySpend: number;
  estimatedMonthlySaving: number;
  model: string;
  topCategories: { callCount: number; category: string; costUsd: number }[];
};

function isPremiumModel(model: string): boolean {
  return model.toLowerCase().includes(PREMIUM_PATTERN);
}

export function computeRoutingRecommendations(
  rows: OrgModelRoutingRow[],
  rangeDays: number,
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
    const topCategories = modelRows
      .map((r) => ({ callCount: r.callCount, category: r.toolCategory, costUsd: r.totalCostUsd }))
      .sort((a, b) => b.costUsd - a.costUsd);
    recommendations.push({
      cheapCategorySpend,
      estimatedMonthlySaving: cheapCategorySpend * HAIKU_SAVINGS_RATIO * normalizeToMonthly,
      model,
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
