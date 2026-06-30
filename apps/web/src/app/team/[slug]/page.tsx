import { FrictionDistributionChart } from '@/components/me/FrictionDistributionChart';
import { ModelMixChart } from '@/components/me/ModelMix';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { TopTools } from '@/components/me/TopTools';
import { CohortFrictionTrendChart } from '@/components/team-org/CohortFrictionTrendChart';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { StatCardWithDelta } from '@/components/team-org/StatCardWithDelta';
import {
  getTeamEffectivenessDistribution,
  getTeamFrictionTrend,
} from '@/lib/effectiveness-queries';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamModelMix,
  getTeamSummaryWithDelta,
  getTeamTopTools,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { TeamSubNav } from './layout';

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

  const { totalCount, visibleIds } = await resolveTeamVisibility(teamId);

  const [{ current: summary, deltas }, tools, models, effectiveness, frictionTrend] =
    await Promise.all([
      getTeamSummaryWithDelta(range, visibleIds, totalCount),
      getTeamTopTools(since, visibleIds),
      getTeamModelMix(since, visibleIds),
      getTeamEffectivenessDistribution(visibleIds, { since }),
      getTeamFrictionTrend(visibleIds, { since }),
    ]);

  const hasData = summary.sessionCount > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Team</p>
          <h1 className="text-2xl font-semibold">{teamName}</h1>
          <p className="mt-1 text-sm text-white/50">Trailing {range} days</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <TeamSubNav slug={slug} active="overview" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCardWithDelta
          label="Sessions"
          value={summary.sessionCount.toString()}
          delta={deltas.sessionCount}
        />
        <StatCardWithDelta
          label="Cost (USD)"
          value={`$${summary.totalCostUsd.toFixed(2)}`}
          delta={deltas.totalCostUsd}
          invertColor
        />
        <StatCardWithDelta
          label="Hours"
          value={summary.totalHours.toFixed(1)}
          delta={deltas.totalHours}
        />
        <StatCardWithDelta
          label="Active members"
          value={summary.activeMembers.toString()}
          delta={deltas.activeMembers}
        />
        <StatCardWithDelta
          label="Cache hit rate"
          value={`${summary.cacheHitRate.toFixed(1)}%`}
          delta={deltas.cacheHitRate}
        />
      </div>

      {!hasData ? (
        <EmptyState />
      ) : (
        <>
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

function EmptyState() {
  return (
    <div className="rounded-lg border border-white/10 p-8 text-center">
      <p className="text-lg font-medium">No activity yet</p>
      <p className="mt-2 text-sm text-white/50">
        Sessions will appear here once team members install the hook and run Claude Code.
      </p>
    </div>
  );
}
