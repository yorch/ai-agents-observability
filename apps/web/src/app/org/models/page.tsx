import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { RoutingRecommendations } from '@/components/team-org/RoutingRecommendations';
import { StatCard } from '@/components/team-org/StatCard';
import type { OrgModelDetailRow, OrgModelRoutingRow } from '@/lib/org-queries';
import { getOrgModelDetail, getOrgModelRoutingBreakdown } from '@/lib/org-queries';
import { getModelInputPrices } from '@/lib/price-client';
import { requireOrgViewer } from '@/lib/roles';
import { buildSavingsRatioResolver, computeRoutingRecommendations } from '@/lib/routing-queries';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

// Models whose names contain these substrings are considered premium-tier.
const PREMIUM_PATTERNS = ['opus'];
// Tool categories considered cheap / read-only work.
const CHEAP_CATEGORIES = new Set(['fs_read', 'search', 'web']);
// Assumed cost ratio of a standard-tier model vs premium (rough Opus→Sonnet).
const DOWNGRADE_SAVINGS_RATE = 0.8;

function modelTier(model: string): 'economy' | 'premium' | 'standard' {
  const lower = model.toLowerCase();
  if (PREMIUM_PATTERNS.some((p) => lower.includes(p))) {
    return 'premium';
  }
  if (lower.includes('haiku')) {
    return 'economy';
  }
  return 'standard';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}K`;
  }
  return String(n);
}

function cacheEfficiencyClass(rate: number): string {
  if (rate >= 0.4) {
    return 'text-emerald-400';
  }
  if (rate >= 0.2) {
    return 'text-yellow-300';
  }
  return 'text-red-400';
}

type RoutingInsight = {
  cheapCostUsd: number;
  cheapPct: number;
  estimatedSavingsUsd: number;
  model: string;
};

function computeRoutingInsights(
  models: OrgModelDetailRow[],
  routing: OrgModelRoutingRow[],
): RoutingInsight[] {
  const insights: RoutingInsight[] = [];
  for (const m of models) {
    if (modelTier(m.model) !== 'premium') {
      continue;
    }
    const cheapCost = routing
      .filter((r) => r.model === m.model && CHEAP_CATEGORIES.has(r.toolCategory))
      .reduce((sum, r) => sum + r.totalCostUsd, 0);
    if (cheapCost === 0 || m.totalCostUsd === 0) {
      continue;
    }
    const cheapPct = cheapCost / m.totalCostUsd;
    if (cheapPct < 0.1) {
      continue;
    }
    insights.push({
      cheapCostUsd: cheapCost,
      cheapPct,
      estimatedSavingsUsd: cheapCost * DOWNGRADE_SAVINGS_RATE,
      model: m.model,
    });
  }
  return insights.sort((a, b) => b.estimatedSavingsUsd - a.estimatedSavingsUsd);
}

export default async function OrgModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const [models, routing, modelPrices] = await Promise.all([
    getOrgModelDetail(since),
    getOrgModelRoutingBreakdown(since),
    getModelInputPrices(),
  ]);

  const totalCostUsd = models.reduce((s, m) => s + m.totalCostUsd, 0);
  const totalInput = models.reduce((s, m) => s + m.inputTokens + m.cacheReadTokens, 0);
  const totalCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
  const orgCacheEfficiency = totalInput > 0 ? totalCacheRead / totalInput : 0;

  // Rough cache savings: cache_read tokens cost ~10% of input tokens for Claude.
  // Savings = cache_read × 0.9 × (avg_cost_per_input_token).
  const avgInputCostPerToken = totalInput > 0 ? totalCostUsd / totalInput : 0;
  const estimatedCacheSavings = totalCacheRead * 0.9 * avgInputCostPerToken;

  const insights = computeRoutingInsights(models, routing);
  // Price-derived per-model savings ratio when the ingest price table is
  // reachable; falls back to the flat heuristic when INGEST_URL is unset.
  const savingsRatioFor = buildSavingsRatioResolver(modelPrices);
  const pricePrecise = modelPrices !== null;
  const { estimatedMonthlySaving: estimatedMonthlyRoutingSaving, recommendations: routingRecs } =
    computeRoutingRecommendations(routing, range, savingsRatioFor);

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days · model spend, cache efficiency, and routing guidance`}
        range={range}
        title="Model Cost Optimization"
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label={`LLM spend (${range}d)`}
          value={totalCostUsd > 0 ? `$${totalCostUsd.toFixed(2)}` : '—'}
        />
        <StatCard
          label="Cache hit rate"
          value={totalInput > 0 ? `${(orgCacheEfficiency * 100).toFixed(1)}%` : '—'}
          note="target: 40–60%"
          accent={orgCacheEfficiency < 0.2 ? 'red' : orgCacheEfficiency < 0.4 ? 'amber' : 'green'}
        />
        <StatCard
          label="Est. cache savings"
          value={estimatedCacheSavings > 0 ? `$${estimatedCacheSavings.toFixed(2)}` : '—'}
          note="vs. paying full input price"
        />
        <StatCard
          label="Active models"
          value={models.length > 0 ? models.length.toString() : '—'}
        />
      </div>

      {models.length === 0 ? (
        <EmptyState>No model usage recorded in the last {range} days.</EmptyState>
      ) : (
        <>
          {/* Routing insights */}
          {insights.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">
                Routing opportunities
              </h2>
              {insights.map((ins) => (
                <div
                  key={ins.model}
                  className="flex flex-wrap items-start gap-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white/90">
                      <span className="font-mono text-amber-300">{ins.model}</span>
                      {' — '}
                      {(ins.cheapPct * 100).toFixed(0)}% of spend on read-only operations
                    </p>
                    <p className="mt-1 text-xs text-white/50">
                      ${ins.cheapCostUsd.toFixed(2)} of cost came from file reads, search, and web
                      lookups that a standard-tier model handles equally well.
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-white/40 uppercase tracking-wider">Est. savings</p>
                    <p className="text-lg font-semibold font-mono text-emerald-400">
                      ${ins.estimatedSavingsUsd.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-white/30">if routed to Sonnet</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Routing recommendations */}
          <RoutingRecommendations
            estimatedMonthlySaving={estimatedMonthlyRoutingSaving}
            pricePrecise={pricePrecise}
            recommendations={routingRecs}
          />

          {/* Model breakdown table */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">
              Spend by model
            </h2>
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-left text-white/30">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Tier</th>
                    <th className="px-4 py-3 text-right font-medium">Sessions</th>
                    <th className="px-4 py-3 text-right font-medium">Cost</th>
                    <th className="px-4 py-3 text-right font-medium">Cost %</th>
                    <th className="px-4 py-3 text-right font-medium">Cache hit</th>
                    <th className="px-4 py-3 text-right font-medium">Input tokens</th>
                    <th className="px-4 py-3 text-right font-medium">Cache read</th>
                    <th className="px-4 py-3 text-right font-medium">Output tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const tier = modelTier(m.model);
                    const costPct = totalCostUsd > 0 ? (m.totalCostUsd / totalCostUsd) * 100 : 0;
                    return (
                      <tr
                        key={m.model}
                        className="border-b border-white/5 hover:bg-white/5 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-white/80">{m.model}</td>
                        <td className="px-4 py-3">
                          <TierBadge tier={tier} />
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/60">
                          {m.sessionCount.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/90 font-medium">
                          ${m.totalCostUsd.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-white/50">
                          {costPct.toFixed(1)}%
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono font-medium ${cacheEfficiencyClass(m.cacheEfficiency)}`}
                        >
                          {(m.cacheEfficiency * 100).toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/50">
                          {fmtTokens(m.inputTokens)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/50">
                          {fmtTokens(m.cacheReadTokens)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/50">
                          {fmtTokens(m.outputTokens)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cache guidance */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">
              Cache efficiency guidance
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <GuidanceCard
                accent="green"
                title="What cache hit rate means"
                body="Claude's prompt cache reuses previous context at ~10% of the input token price. A 40–60% cache hit rate is typical for iterative coding sessions. Below 20% suggests sessions are starting fresh each time."
              />
              <GuidanceCard
                accent="amber"
                title="How to improve cache efficiency"
                body="Keep system prompts and file context stable across turns. Avoid regenerating tool outputs that haven't changed. Long-running sessions naturally accumulate cache — encourage fewer session restarts."
              />
              <GuidanceCard
                accent="blue"
                title="Model routing quick wins"
                body="File reads, grep, and web searches don't require Opus-level reasoning. Routing these to Haiku or Sonnet reduces cost 5–15× per call with no quality loss. Claude Code's model selection is controllable via the model field in API calls."
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TierBadge({ tier }: { tier: 'economy' | 'premium' | 'standard' }) {
  if (tier === 'premium') {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/20">
        premium
      </span>
    );
  }
  if (tier === 'economy') {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        economy
      </span>
    );
  }
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20">
      standard
    </span>
  );
}

function GuidanceCard({
  accent,
  body,
  title,
}: {
  accent: 'amber' | 'blue' | 'green';
  body: string;
  title: string;
}) {
  const borderCls =
    accent === 'green'
      ? 'border-emerald-500/30'
      : accent === 'amber'
        ? 'border-amber-500/30'
        : 'border-blue-500/30';
  const titleCls =
    accent === 'green'
      ? 'text-emerald-400'
      : accent === 'amber'
        ? 'text-amber-300'
        : 'text-blue-400';
  return (
    <div className={`rounded-lg border ${borderCls} bg-white/5 p-4 space-y-2`}>
      <p className={`text-xs font-semibold ${titleCls}`}>{title}</p>
      <p className="text-xs text-white/50 leading-relaxed">{body}</p>
    </div>
  );
}
