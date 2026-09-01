import { ReportRangeControls } from '@/components/team-org/ReportRangeControls';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState } from '@/components/ui';
import { parseReportRange } from '@/lib/reporting-range';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgCostDuration } from '@/lib/scatter-queries';
import {
  getOrgActivityHeatmap,
  getOrgConcurrency,
  getOrgTrends,
  listTrendRepos,
} from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function OrgTrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  await requireOrgViewer();
  const params = await searchParams;
  const window = parseReportRange(params);
  // A custom from/to window is not a preset. This used to coerce anything that
  // was not 7/30/90 down to 30, so a 45-day window was labelled "trailing 30
  // days" while the charts drew 45 and the 30d chip claimed to be selected.
  const custom = Boolean(params.from || params.to);
  const range = custom
    ? null
    : (([7, 30, 90].includes(window.days) ? window.days : 30) as 7 | 30 | 90);
  const since = window.start;
  const [points, scatter, concurrency, heatmap, repos] = await Promise.all([
    getOrgTrends(since, { repo: params.repo, until: window.end }),
    getOrgCostDuration(since, { repo: params.repo, until: window.end }),
    getOrgConcurrency(since, { repo: params.repo, until: window.end }),
    getOrgActivityHeatmap(since, window.end, window.timezone, params.repo),
    listTrendRepos(),
  ]);
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Organization</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            Organization trends
          </h1>
          <p className="mt-1 text-sm text-text-2">
            Daily activity and model mix ·{' '}
            {custom
              ? `${window.from} → ${window.to} (${window.days} days)`
              : `trailing ${range} days`}
          </p>
        </div>
        <ReportRangeControls
          basePath="/org/trends"
          range={range}
          from={params.from}
          to={params.to}
          timezone={window.timezone}
          repo={params.repo}
          repos={repos}
        />
      </div>
      {points.length === 0 ? (
        <EmptyState title="No activity in this period">
          Shared team sessions will appear here once agents report activity.
        </EmptyState>
      ) : (
        <ScopedTrendCharts
          aggregateScatter
          concurrency={concurrency}
          heatmap={heatmap}
          points={points}
          scatter={scatter}
        />
      )}
    </div>
  );
}
