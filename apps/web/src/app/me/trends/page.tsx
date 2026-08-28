import { redirect } from 'next/navigation';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { getUserCostDuration } from '@/lib/scatter-queries';
import { daysAgo } from '@/lib/time';
import { getUserActivityHeatmap, getUserConcurrency, getUserTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function MeTrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  const raw = Number((await searchParams).range);
  const range = ([7, 30, 90].includes(raw) ? raw : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const [points, scatter, concurrency, heatmap] = await Promise.all([
    getUserTrends(user.id, since),
    getUserCostDuration(user.id, since),
    getUserConcurrency(user.id, since),
    getUserActivityHeatmap(user.id, since),
  ]);
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            My trends
          </h1>
          <p className="mt-1 text-sm text-text-2">
            Daily activity and model mix · trailing {range} days
          </p>
        </div>
        <DateRangePicker range={range} />
      </div>
      {points.length === 0 ? (
        <EmptyState title="No activity in this period">
          Install an adapter and run a session to start seeing trends.
        </EmptyState>
      ) : (
        <ScopedTrendCharts concurrency={concurrency} heatmap={heatmap} points={points} scatter={scatter} />
      )}
    </div>
  );
}
