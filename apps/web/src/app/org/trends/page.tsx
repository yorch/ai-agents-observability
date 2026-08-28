import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState } from '@/components/ui';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgCostDuration } from '@/lib/scatter-queries';
import { daysAgo } from '@/lib/time';
import { getOrgTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function OrgTrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const raw = Number((await searchParams).range);
  const range = ([7, 30, 90].includes(raw) ? raw : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const [points, scatter] = await Promise.all([getOrgTrends(since), getOrgCostDuration(since)]);
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Organization</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            Organization trends
          </h1>
          <p className="mt-1 text-sm text-text-2">
            Daily activity and model mix · trailing {range} days
          </p>
        </div>
        <DateRangePicker range={range} />
      </div>
      {points.length === 0 ? (
        <EmptyState title="No activity in this period">
          Shared team sessions will appear here once agents report activity.
        </EmptyState>
      ) : (
        <ScopedTrendCharts points={points} scatter={scatter} aggregateScatter />
      )}
    </div>
  );
}
