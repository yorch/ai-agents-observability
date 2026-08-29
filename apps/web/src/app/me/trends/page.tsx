import { redirect } from 'next/navigation';
import { ReportRangeControls } from '@/components/team-org/ReportRangeControls';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { currentUser } from '@/lib/auth';
import { parseReportRange } from '@/lib/reporting-range';
import { getUserCostDuration } from '@/lib/scatter-queries';
import { getUserActivityHeatmap, getUserConcurrency, getUserTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function MeTrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  const { dict } = await getTranslations();
  const params = await searchParams;
  const window = parseReportRange(params);
  const range = ([7, 30, 90].includes(window.days) ? window.days : 30) as 7 | 30 | 90;
  const since = window.start;
  const [points, scatter, concurrency, heatmap] = await Promise.all([
    getUserTrends(user.id, since, { repo: params.repo, until: window.end }),
    getUserCostDuration(user.id, since, { repo: params.repo, until: window.end }),
    getUserConcurrency(user.id, since, { repo: params.repo, until: window.end }),
    getUserActivityHeatmap(user.id, since, window.end, window.timezone, params.repo),
  ]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            My trends
          </h1>
          <p className="mt-1 text-sm text-text-2">
            Daily activity and model mix · trailing {range} days
          </p>
        </div>
        <ReportRangeControls
          range={range}
          from={params.from}
          to={params.to}
          timezone={window.timezone}
          repo={params.repo}
        />
      </div>
      {points.length === 0 ? (
        <EmptyState title={dict.me.trends.empty}>
          Install an adapter and run a session to start seeing trends.
        </EmptyState>
      ) : (
        <ScopedTrendCharts
          concurrency={concurrency}
          heatmap={heatmap}
          points={points}
          scatter={scatter}
        />
      )}
    </div>
  );
}
