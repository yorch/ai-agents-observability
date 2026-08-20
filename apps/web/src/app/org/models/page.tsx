import { PageHeader } from '@/components/team-org/PageHeader';
import { ProjectionRealization } from '@/components/team-org/ProjectionRealization';
import { RoutingByTeam } from '@/components/team-org/RoutingByTeam';
import type { RegisteredRoutingClaim } from '@/components/team-org/RoutingRecommendations';
import { RoutingRecommendations } from '@/components/team-org/RoutingRecommendations';
import { Cell, EmptyState, Row, Stat, Table } from '@/components/ui';
import { fmtTokens } from '@/lib/fmt';
import {
  getOrgModelDetail,
  getOrgModelRoutingBreakdown,
  getRoutingSpendByTeam,
} from '@/lib/org-queries';
import { getModelInputPrices } from '@/lib/price-client';
import { getGuardMetrics, getRoutingActuals } from '@/lib/projection-queries';
import {
  listClosedProjections,
  realizeProjection,
  recordProjections,
  startOfUtcDay,
} from '@/lib/projections';
import { requireOrgViewer } from '@/lib/roles';
import {
  buildSavingsRatioResolver,
  computeRoutingRecommendations,
  routingSavingRange,
} from '@/lib/routing-queries';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

// Models whose names contain these substrings are considered premium-tier.
const PREMIUM_PATTERNS = ['opus'];

// A routing claim is about the *next* month's retrieval spend for one model.
const ROUTING_CLAIM_DAYS = 30;

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

// The "Routing opportunities" banner that used to sit here made the same claim as
// the recommendations below it, from a hardcoded 0.8 savings rate and as a single
// number. P13-006 removed it rather than registering it: two unreconciled
// estimates of one saving is worse than one registered range, and a point
// estimate is precisely what the projection registry exists to stop shipping.

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

  // Price-derived per-model savings ratio when the ingest price table is
  // reachable; falls back to the flat heuristic when INGEST_URL is unset.
  const savingsRatioFor = buildSavingsRatioResolver(modelPrices);
  // Only claim price-precision when the table actually yielded usable rates — an
  // empty map falls back to the flat heuristic inside buildSavingsRatioResolver.
  const pricePrecise = modelPrices !== null && Object.keys(modelPrices).length > 0;
  const { recommendations: routingRecs } = computeRoutingRecommendations(
    routing,
    range,
    savingsRatioFor,
  );

  // P13-006: register every recommendation as a projection at the moment it is
  // rendered. `RegisteredProjection` is the only thing RoutingRecommendations
  // will display a saving from, so a claim that reaches the screen is a claim
  // that is on the record and can be checked later. Nothing retroactive: claims
  // made before this existed have no record and are not invented.
  const now = new Date();
  const claimStart = startOfUtcDay(now);
  const claimEnd = new Date(claimStart.getTime() + ROUTING_CLAIM_DAYS * 86_400_000);
  const guardBaseline = await getGuardMetrics(daysAgo(range), now);
  const projections = await recordProjections(
    routingRecs.map((rec) => {
      const { high, low } = routingSavingRange(rec);
      return {
        // The observed retrieval spend the claim is measured against, normalized
        // to the same monthly basis as the projected saving.
        baselineValue: rec.cheapCategorySpend * (range > 0 ? 30 / range : 0),
        baselineWindowDays: range,
        claimType: 'routing_savings' as const,
        guardBaseline,
        metadata: { pricePrecise, savingsRatio: rec.savingsRatio },
        periodEnd: claimEnd,
        periodStart: claimStart,
        // Which price table produced the ratio, so the check replays against it
        // rather than measuring a repricing as a routing result.
        priceTableVersion: pricePrecise ? 'ingest:current' : null,
        projectedHigh: high,
        projectedLow: low,
        segment: rec.model,
      };
    }),
  );
  const routingClaims: RegisteredRoutingClaim[] = routingRecs
    .map((rec, i) => ({
      // recordProjections preserves input order, so index alignment is safe; the
      // find is a belt-and-braces guard against that changing silently.
      projection: projections.find((p) => p.segment === rec.model) ?? projections[i],
      recommendation: rec,
    }))
    .filter((c): c is RegisteredRoutingClaim => c.projection !== undefined);

  // …and check the ones whose period has closed. `realizeProjection` is pure;
  // everything time- or data-dependent is passed in.
  const closed = await listClosedProjections('routing_savings', now);
  const realizations = await Promise.all(
    closed.map(async (p) =>
      realizeProjection(p, await getRoutingActuals(p.segment, p.periodStart, p.periodEnd), now),
    ),
  );

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
          {/* Routing recommendations */}
          <RoutingRecommendations claims={routingClaims} pricePrecise={pricePrecise} />

          {/* Did the recommendations work? (P13-006, supersedes P10-006) */}
          <ProjectionRealization
            caption="Every routing recommendation is recorded when it is shown, then compared against the retrieval spend that actually followed — with an outcome guard, so a saving that came with more friction, tool errors or reverts is flagged rather than celebrated."
            realizations={realizations}
            title="Recommendations vs what happened"
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
