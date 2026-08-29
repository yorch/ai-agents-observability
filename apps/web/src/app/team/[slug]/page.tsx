import { CostAttributionNote } from '@/components/CostAttributionNote';
import { FrictionDistributionChart } from '@/components/me/FrictionDistributionChart';
import { ModelMixChart } from '@/components/me/ModelMix';
import { OversightPanel } from '@/components/me/OversightPanel';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { TopTools } from '@/components/me/TopTools';
import { CohortFrictionTrendChart } from '@/components/team-org/CohortFrictionTrendChart';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { Card, CardEmpty, EmptyState, Stat } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { getAttributionCoverage } from '@/lib/attribution-coverage';
import {
  getTeamEffectivenessDistribution,
  getTeamFrictionTrend,
} from '@/lib/effectiveness-queries';
import { fmtUsd } from '@/lib/fmt';
import { getModelPolicies } from '@/lib/model-policy';
import { getTeamOversight } from '@/lib/oversight-queries';
import { requireTeamLead } from '@/lib/roles';
import { computeRoutingRecommendations } from '@/lib/routing-queries';
import {
  getTeamModelMix,
  getTeamRoutingBreakdown,
  getTeamSummaryWithDelta,
  getTeamTopTools,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function TeamOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);

  const { teamId, teamName } = await requireTeamLead(slug);
  const { dict } = await getTranslations();

  const { totalCount, visibleIds } = await resolveTeamVisibility(teamId);

  const [
    { current: summary, deltas },
    tools,
    models,
    routing,
    effectiveness,
    frictionTrend,
    oversight,
    coverage,
  ] = await Promise.all([
    getTeamSummaryWithDelta(range, visibleIds, totalCount),
    getTeamTopTools(since, visibleIds),
    getTeamModelMix(since, visibleIds),
    getTeamRoutingBreakdown(since, visibleIds),
    getTeamEffectivenessDistribution(visibleIds, { since }),
    getTeamFrictionTrend(visibleIds, { since }),
    getTeamOversight(visibleIds, since),
    // The routing card's dollars are the P14-005 redistribution, which exists
    // only for events that carry turn linkage — so the card states its coverage
    // rather than letting a short list read as efficient routing.
    getAttributionCoverage(visibleIds, since),
  ]);

  const policies = await getModelPolicies(routing.map((r) => r.agentType));
  const {
    estimatedMonthlySavingHigh,
    estimatedMonthlySavingLow,
    recommendations: routingRecs,
  } = computeRoutingRecommendations(routing, range, policies);

  const hasData = summary.sessionCount > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">
            {dict.team.overview.breadcrumb}
          </p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            {teamName}
          </h1>
          <p className="mt-1 text-sm text-text-2">
            {format(dict.team.overview.trailing, { range })}
          </p>
        </div>
        <DateRangePicker range={range} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat
          label={dict.team.overview.sessions}
          value={summary.sessionCount.toString()}
          delta={deltas.sessionCount}
        />
        <Stat
          label={dict.team.overview.cost}
          value={`$${summary.totalCostUsd.toFixed(2)}`}
          delta={deltas.totalCostUsd}
          deltaInverted
        />
        <Stat
          label={dict.team.overview.hours}
          value={summary.totalHours.toFixed(1)}
          delta={deltas.totalHours}
        />
        <Stat
          label={dict.team.overview.activeMembers}
          value={summary.activeMembers.toString()}
          delta={deltas.activeMembers}
        />
        <Stat
          label={dict.team.overview.cacheHitRate}
          value={`${summary.cacheHitRate.toFixed(1)}%`}
          delta={deltas.cacheHitRate}
        />
      </div>

      {!hasData ? (
        <EmptyState title={dict.team.overview.empty}>
          Sessions will appear here once team members install the hook and run Claude Code.
        </EmptyState>
      ) : (
        <>
          <OversightPanel data={oversight} />
          <div className="grid gap-6 md:grid-cols-2">
            <Card title="Team routing opportunities" caption={`Trailing ${range} days`}>
              {routingRecs.length === 0 ? (
                <div className="space-y-3">
                  <CardEmpty>No high-confidence routing opportunities in this period.</CardEmpty>
                  <CostAttributionNote coverage={coverage} />
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-text-2">
                    Estimated{' '}
                    <span className="font-mono text-good">
                      {fmtUsd(estimatedMonthlySavingLow)}–{fmtUsd(estimatedMonthlySavingHigh)} / mo
                    </span>{' '}
                    by routing retrieval-heavy turns to a cheaper model.
                  </p>
                  {routingRecs.slice(0, 3).map((r) => (
                    <div
                      key={`${r.agentType}:${r.model}`}
                      className="rounded border border-border bg-surface-2 px-3 py-2"
                    >
                      <p className="text-sm text-text">
                        <span className="font-mono">{r.model}</span> ·{' '}
                        {fmtUsd(r.cheapCategorySpend)} retrieval spend
                      </p>
                      <p className="text-xs text-text-3">
                        {r.cheapCategoryCalls.toLocaleString()} calls · confidence {r.confidence}
                      </p>
                    </div>
                  ))}
                  <CostAttributionNote coverage={coverage} />
                </div>
              )}
            </Card>
            <Card
              title="Team cache efficiency guidance"
              caption={`Current hit rate: ${summary.cacheHitRate.toFixed(1)}%`}
            >
              {summary.cacheHitRate < 20 ? (
                <p className="text-sm text-text-2">
                  Cache reuse is low for this team. Encourage longer-running sessions and stable
                  prompt/context scaffolds to reduce repeated full-price input tokens.
                </p>
              ) : summary.cacheHitRate < 40 ? (
                <p className="text-sm text-text-2">
                  Cache reuse is moderate. A small push toward fewer restarts and consistent context
                  can move this into the 40–60% efficient range.
                </p>
              ) : (
                <p className="text-sm text-text-2">
                  Cache reuse is in the healthy range. Keep current session continuity habits to
                  sustain savings.
                </p>
              )}
            </Card>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <TopTools title="Top Tools" tools={tools} />
            <ModelMixChart models={models} />
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <FrictionDistributionChart distribution={effectiveness} />
            <ShapeDistributionChart histogram={effectiveness.shapeMix} />
          </div>
          <CohortFrictionTrendChart points={frictionTrend} title="Team friction trend (weekly)" />
        </>
      )}
    </div>
  );
}
