import { PageHeader } from '@/components/team-org/PageHeader';
import { RoutingByTeam } from '@/components/team-org/RoutingByTeam';
import { RoutingRecommendations } from '@/components/team-org/RoutingRecommendations';
import { Cell, EmptyState, Row, Stat, Table } from '@/components/ui';
import { fmtTokens } from '@/lib/fmt';
import type { OrgModelDetailRow, OrgModelRoutingRow } from '@/lib/org-queries';
import {
  getOrgModelDetail,
  getOrgModelRoutingBreakdown,
  getRoutingSpendByTeam,
} from '@/lib/org-queries';
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

function cacheEfficiencyClass(rate: number): string {
  if (rate >= 0.4) {
    return 'text-good';
  }
  if (rate >= 0.2) {
    return 'text-warn';
  }
  return 'text-crit';
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
  const [models, routing, modelPrices, routingByTeam] = await Promise.all([
    getOrgModelDetail(since),
    getOrgModelRoutingBreakdown(since),
    getModelInputPrices(),
    getRoutingSpendByTeam(since),
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
  // Only claim price-precision when the table actually yielded usable rates — an
  // empty map falls back to the flat heuristic inside buildSavingsRatioResolver.
  const pricePrecise = modelPrices !== null && Object.keys(modelPrices).length > 0;
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
        <Stat
          label={`LLM spend (${range}d)`}
          value={totalCostUsd > 0 ? `$${totalCostUsd.toFixed(2)}` : '—'}
        />
        <Stat
          label="Cache hit rate"
          value={totalInput > 0 ? `${(orgCacheEfficiency * 100).toFixed(1)}%` : '—'}
          note="target: 40–60%"
          accent={orgCacheEfficiency < 0.2 ? 'crit' : orgCacheEfficiency < 0.4 ? 'warn' : 'good'}
        />
        <Stat
          label="Est. cache savings"
          value={estimatedCacheSavings > 0 ? `$${estimatedCacheSavings.toFixed(2)}` : '—'}
          note="vs. paying full input price"
        />
        <Stat label="Active models" value={models.length > 0 ? models.length.toString() : '—'} />
      </div>

      {models.length === 0 ? (
        <EmptyState>No model usage recorded in the last {range} days.</EmptyState>
      ) : (
        <>
          {/* Routing insights */}
          {insights.length > 0 && (
            <div className="space-y-3">
              <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
                Routing opportunities
              </h2>
              {insights.map((ins) => (
                <div
                  key={ins.model}
                  className="flex flex-wrap items-start gap-4 rounded-lg border border-warn-line bg-warn-soft p-4"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text">
                      <span className="font-mono text-warn">{ins.model}</span>
                      {' — '}
                      {(ins.cheapPct * 100).toFixed(0)}% of spend on read-only operations
                    </p>
                    <p className="mt-1 text-xs text-text-2">
                      ${ins.cheapCostUsd.toFixed(2)} of cost came from file reads, search, and web
                      lookups that a standard-tier model handles equally well.
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-text-3 uppercase tracking-wider">Est. savings</p>
                    <p className="text-lg font-semibold font-mono text-good">
                      ${ins.estimatedSavingsUsd.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-text-3">if routed to Sonnet</p>
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

          {/* Routing accountability by team */}
          <RoutingByTeam rows={routingByTeam} />

          {/* Model breakdown table */}
          <div className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
              Spend by model
            </h2>
            <Table
              columns={[
                { label: 'Model' },
                { label: 'Tier' },
                { align: 'right', label: 'Sessions' },
                { align: 'right', label: 'Cost' },
                { align: 'right', label: 'Cost %' },
                { align: 'right', label: 'Cache hit' },
                { align: 'right', label: 'Input tokens' },
                { align: 'right', label: 'Cache read' },
                { align: 'right', label: 'Output tokens' },
              ]}
            >
              {models.map((m) => {
                const tier = modelTier(m.model);
                const costPct = totalCostUsd > 0 ? (m.totalCostUsd / totalCostUsd) * 100 : 0;
                return (
                  <Row key={m.model}>
                    <Cell className="text-text">{m.model}</Cell>
                    <Cell>
                      <TierBadge tier={tier} />
                    </Cell>
                    <Cell num className="text-text-2">
                      {m.sessionCount.toLocaleString()}
                    </Cell>
                    <Cell num className="text-text">
                      ${m.totalCostUsd.toFixed(2)}
                    </Cell>
                    <Cell num className="text-text-2">
                      {costPct.toFixed(1)}%
                    </Cell>
                    <Cell
                      num
                      className={`px-4 py-3 text-right font-mono font-medium ${cacheEfficiencyClass(m.cacheEfficiency)}`}
                    >
                      {(m.cacheEfficiency * 100).toFixed(1)}%
                    </Cell>
                    <Cell num className="text-text-2">
                      {fmtTokens(m.inputTokens)}
                    </Cell>
                    <Cell num className="text-text-2">
                      {fmtTokens(m.cacheReadTokens)}
                    </Cell>
                    <Cell num className="text-text-2">
                      {fmtTokens(m.outputTokens)}
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          </div>

          {/* Cache guidance */}
          <div className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
              Cache efficiency guidance
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <GuidanceCard
                accent="good"
                title="What cache hit rate means"
                body="Claude's prompt cache reuses previous context at ~10% of the input token price. A 40–60% cache hit rate is typical for iterative coding sessions. Below 20% suggests sessions are starting fresh each time."
              />
              <GuidanceCard
                accent="warn"
                title="How to improve cache efficiency"
                body="Keep system prompts and file context stable across turns. Avoid regenerating tool outputs that haven't changed. Long-running sessions naturally accumulate cache — encourage fewer session restarts."
              />
              <GuidanceCard
                accent="series1"
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
      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-warn-soft text-warn border border-warn-line">
        premium
      </span>
    );
  }
  if (tier === 'economy') {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-good-soft text-good border border-good-line">
        economy
      </span>
    );
  }
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-series-1/10 text-series-1 border border-series-1/30">
      standard
    </span>
  );
}

function GuidanceCard({
  accent,
  body,
  title,
}: {
  accent: 'good' | 'series1' | 'warn';
  body: string;
  title: string;
}) {
  const borderCls =
    accent === 'good'
      ? 'border-good-line'
      : accent === 'warn'
        ? 'border-warn-line'
        : 'border-series-1/40';
  const titleCls =
    accent === 'good' ? 'text-good' : accent === 'warn' ? 'text-warn' : 'text-series-1';
  return (
    <div className={`rounded-lg border ${borderCls} bg-surface p-4 space-y-2`}>
      <p className={`text-xs font-semibold ${titleCls}`}>{title}</p>
      <p className="text-xs text-text-2 leading-relaxed">{body}</p>
    </div>
  );
}
