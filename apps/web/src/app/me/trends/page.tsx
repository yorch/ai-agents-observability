import { ReportRangeControls } from '@/components/team-org/ReportRangeControls';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState, PageHeader } from '@/components/ui';
import { currentUser, redirectToLogin } from '@/lib/auth';
import { parseReportRange } from '@/lib/reporting-range';
import { getUserCostDuration } from '@/lib/scatter-queries';
import {
  getUserActivityHeatmap,
  getUserConcurrency,
  getUserTrends,
  listTrendRepos,
} from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function MeTrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    return redirectToLogin();
  }
  const params = await searchParams;
  const window = parseReportRange(params);
  // A custom from/to window is not a preset — see the note on /org/trends.
  const custom = Boolean(params.from || params.to);
  const range = custom
    ? null
    : (([7, 30, 90].includes(window.days) ? window.days : 30) as 7 | 30 | 90);
  const since = window.start;
  const [points, scatter, concurrency, heatmap, repos] = await Promise.all([
    getUserTrends(user.id, since, { repo: params.repo, until: window.end }),
    getUserCostDuration(user.id, since, { repo: params.repo, until: window.end }),
    getUserConcurrency(user.id, since, { repo: params.repo, until: window.end }),
    getUserActivityHeatmap(user.id, since, window.end, window.timezone, params.repo),
    listTrendRepos([user.id]),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Me"
        title="My trends"
        description={
          <>
            Daily activity and model mix ·{' '}
            {custom
              ? `${window.from} → ${window.to} (${window.days} days)`
              : `trailing ${range} days`}
          </>
        }
        action={
          <ReportRangeControls
            basePath="/me/trends"
            range={range}
            from={params.from}
            to={params.to}
            timezone={window.timezone}
            repo={params.repo}
            repos={repos}
          />
        }
      />
      {points.length === 0 ? (
        <EmptyState title="No activity in this period">
          Install an adapter and run a session to start seeing trends.
        </EmptyState>
      ) : (
        <ScopedTrendCharts
          concurrency={concurrency}
          heatmap={heatmap}
          points={points}
          scatter={scatter}
          timezone={window.timezone}
        />
      )}
    </div>
  );
}
