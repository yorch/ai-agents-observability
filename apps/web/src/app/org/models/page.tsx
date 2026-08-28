import {
  type ModelPolicySnapshot,
  type ModelTier,
  resolveModelTier,
} from '@ai-agents-observability/schemas';
import { CostAttributionNote } from '@/components/CostAttributionNote';
import { PageHeader } from '@/components/team-org/PageHeader';
import { ProjectionRealization } from '@/components/team-org/ProjectionRealization';
import { RoutingByTeam } from '@/components/team-org/RoutingByTeam';
import type { RegisteredRoutingClaim } from '@/components/team-org/RoutingRecommendations';
import { RoutingRecommendations } from '@/components/team-org/RoutingRecommendations';
import { Cell, EmptyState, Row, Stat, Table } from '@/components/ui';
import { getAttributionCoverage } from '@/lib/attribution-coverage';
import { fmtTokens } from '@/lib/fmt';
import { getModelPolicies } from '@/lib/model-policy';
import {
  getOrgModelDetail,
  getOrgModelRoutingBreakdown,
  getRoutingSpendByTeam,
  orgVisibleUserIds,
} from '@/lib/org-queries';
import { getGuardMetrics, getRoutingActuals } from '@/lib/projection-queries';
import {
  listClosedProjections,
  realizeProjection,
  recordProjections,
  startOfUtcDay,
} from '@/lib/projections';
import { requireOrgViewer } from '@/lib/roles';
import { computeRoutingRecommendations, type RoutingRecommendation } from '@/lib/routing-queries';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

// A routing claim is about the *next* month's retrieval spend for one model.
const ROUTING_CLAIM_DAYS = 30;

/**
 * The tier to label a model with in the spend-by-model table.
 *
 * A tier is agent-relative — it is derived by ranking one agent's own price
 * table (packages/schemas `model-policy.ts`), so the same model id can sit in
 * different bands under two agents. `getOrgModelDetail` aggregates spend by
 * model with no agent dimension, so of the two options the table can honestly
 * offer, this is the one available: report a tier only when every agent that
 * prices the model agrees, and otherwise show none. Grouping the table by
 * (agent, model) would be the other answer, but it needs a different query and
 * `org-queries.ts` is not this change's business. Picking one agent's tier
 * arbitrarily is the option that is never right.
 */
function tierAcrossAgents(
  policies: Map<string, ModelPolicySnapshot>,
  model: string,
): ModelTier | null {
  const seen = new Set<ModelTier>();
  for (const policy of policies.values()) {
    const tier = resolveModelTier(policy, model);
    if (tier) {
      seen.add(tier);
    }
  }
  return seen.size === 1 ? ([...seen][0] as ModelTier) : null;
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
  const visibleIds = await orgVisibleUserIds(since);
  const [models, routing, coverage] = await Promise.all([
    getOrgModelDetail(since),
    getOrgModelRoutingBreakdown(since),
    // Every dollar in the routing half of this page is a P14-005
    // redistribution, and a redistribution needs the per-turn linkage the agent
    // adapter reports. Where that is missing the figures are absent rather than
    // zero, so the same coverage line the tool / skill / sub-agent surfaces
    // carry belongs here too — this is the page whose numbers were fiction the
    // longest.
    getAttributionCoverage(visibleIds, since),
  ]);

  // Resolve policy once per agent that actually has routing spend, then reuse it
  // for the recommendations, the team accountability table, and the tier labels.
  // Sequenced after the breakdown rather than folded into the Promise.all above
  // because both consumers need the agent list it returns.
  const policies = await getModelPolicies(routing.map((r) => r.agentType));
  const routingByTeam = await getRoutingSpendByTeam(since, policies);

  const totalCostUsd = models.reduce((s, m) => s + m.totalCostUsd, 0);
  const totalInput = models.reduce((s, m) => s + m.inputTokens + m.cacheReadTokens, 0);
  const totalCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
  const orgCacheEfficiency = totalInput > 0 ? totalCacheRead / totalInput : 0;

  // Rough cache savings: cache_read tokens cost ~10% of input tokens for Claude.
  // Savings = cache_read × 0.9 × (avg_cost_per_input_token).
  const avgInputCostPerToken = totalInput > 0 ? totalCostUsd / totalInput : 0;
  const estimatedCacheSavings = totalCacheRead * 0.9 * avgInputCostPerToken;

  // Tiers, cheap categories and savings ranges all come from each agent's own
  // resolved policy — never a substring of the model id. An agent whose price
  // table is unreachable still gets a snapshot, just an unpriced one, so its
  // models surface as `unpricedModels` rather than as a fabricated tier.
  const {
    belowConfidenceThreshold,
    recommendations: routingRecs,
    unpricedModels,
  } = computeRoutingRecommendations(routing, range, policies);

  // A claim is registered per MODEL, not per (agent, model): `getRoutingActuals`
  // measures `model = segment` across the org, so a segment of `agent:model`
  // would match no rows and every claim would realize as "not yet measurable"
  // forever. Recommendations that share a model id are therefore folded into one
  // claim whose range is the sum of theirs — which also keeps the headline total
  // from counting the same model twice.
  const recsByModel = new Map<string, RoutingRecommendation[]>();
  for (const rec of routingRecs) {
    const group = recsByModel.get(rec.model);
    if (group) {
      group.push(rec);
    } else {
      recsByModel.set(rec.model, [rec]);
    }
  }
  const claimGroups = [...recsByModel].map(([model, recs]) => ({ model, recs }));

  // P13-006: register every recommendation as a projection at the moment it is
  // rendered. `RegisteredProjection` is the only thing RoutingRecommendations
  // will display a saving from, so a claim that reaches the screen is a claim
  // that is on the record and can be checked later. Nothing retroactive: claims
  // made before this existed have no record and are not invented.
  const now = new Date();
  const claimStart = startOfUtcDay(now);
  const claimEnd = new Date(claimStart.getTime() + ROUTING_CLAIM_DAYS * 86_400_000);
  const guardBaseline = await getGuardMetrics(daysAgo(range), now);
  const toMonthly = range > 0 ? 30 / range : 0;
  const projections = await recordProjections(
    claimGroups.map(({ model, recs }) => ({
      // The observed retrieval spend the claim is measured against, normalized
      // to the same monthly basis as the projected saving.
      baselineValue: recs.reduce((s, r) => s + r.cheapCategorySpend, 0) * toMonthly,
      baselineWindowDays: range,
      claimType: 'routing_savings' as const,
      guardBaseline,
      // Per-agent provenance, so a later check can tell "the routing worked"
      // apart from "an admin re-tiered the model in between".
      metadata: {
        agents: recs.map((r) => ({
          agentType: r.agentType,
          confidence: r.confidence,
          exampleTargetModel: r.exampleTargetModel,
          targetTier: r.targetTier,
          tier: r.tier,
        })),
      },
      periodEnd: claimEnd,
      periodStart: claimStart,
      // A recommendation only exists when the model AND a cheaper target are
      // priced, so every routing claim is price-derived; record which table
      // produced it so the check replays against it rather than measuring a
      // repricing as a routing result.
      priceTableVersion: 'ingest:current',
      projectedHigh: recs.reduce((s, r) => s + r.monthlySavingHigh, 0),
      projectedLow: recs.reduce((s, r) => s + r.monthlySavingLow, 0),
      segment: model,
    })),
  );
  const routingClaims: RegisteredRoutingClaim[] = claimGroups
    .map(({ model, recs }, i) => ({
      // recordProjections preserves input order, so index alignment is safe; the
      // find is a belt-and-braces guard against that changing silently.
      projection: projections.find((p) => p.segment === model) ?? projections[i],
      recommendations: recs,
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
          <RoutingRecommendations
            belowConfidenceThreshold={belowConfidenceThreshold}
            claims={routingClaims}
            unpricedModels={unpricedModels}
          />
          <CostAttributionNote coverage={coverage} />

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
                const tier = tierAcrossAgents(policies, m.model);
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
                body="Prompt caching reuses previous context at a fraction of the input token price — around a tenth, on most providers' tables. A 40–60% cache hit rate is typical for iterative coding sessions. Below 20% suggests sessions are starting fresh each time."
              />
              <GuidanceCard
                accent="warn"
                title="How to improve cache efficiency"
                body="Keep system prompts and file context stable across turns. Avoid regenerating tool outputs that haven't changed. Long-running sessions naturally accumulate cache — encourage fewer session restarts."
              />
              <GuidanceCard
                accent="series1"
                title="Model routing quick wins"
                body="File reads, grep, and web searches don't require premium-tier reasoning. Routing them to a cheaper tier typically cuts cost several-fold per call with no quality loss. The recommendations above name the target tier and an example model for each agent, derived from that agent's own price table."
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TierBadge({ tier }: { tier: ModelTier | null }) {
  if (tier === null) {
    return <span className="text-text-3">—</span>;
  }
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
