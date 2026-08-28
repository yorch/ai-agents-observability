import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import { getTeamCostDuration } from '@/lib/scatter-queries';
import { resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { getTeamTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function TeamTrendsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const raw = Number((await searchParams).range);
  const range = ([7, 30, 90].includes(raw) ? raw : 30) as 7 | 30 | 90;
  const { teamId, teamName } = await requireTeamLead(slug);
  const { visibleIds } = await resolveTeamVisibility(teamId);
  const since = daysAgo(range);
  const [points, scatter] = await Promise.all([
    getTeamTrends(visibleIds, since),
    getTeamCostDuration(visibleIds, since),
  ]);
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Team</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            {teamName} trends
          </h1>
          <p className="mt-1 text-sm text-text-2">
            Daily activity and model mix · trailing {range} days
          </p>
        </div>
        <DateRangePicker range={range} />
      </div>
      {points.length === 0 ? (
        <EmptyState title="No activity in this period">
          Visible team sessions will appear here once members run an adapter.
        </EmptyState>
      ) : (
        <ScopedTrendCharts points={points} scatter={scatter} aggregateScatter />
      )}
    </div>
  );
}
