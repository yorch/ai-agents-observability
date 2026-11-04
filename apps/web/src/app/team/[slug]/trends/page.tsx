import { ReportRangeControls } from '@/components/team-org/ReportRangeControls';
import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { EmptyState, PageHeader } from '@/components/ui';
import { parseReportRange } from '@/lib/reporting-range';
import { requireTeamLead } from '@/lib/roles';
import { getTeamCostDuration } from '@/lib/scatter-queries';
import { resolveTeamVisibility } from '@/lib/team-queries';
import {
  getTeamActivityHeatmap,
  getTeamConcurrency,
  getTeamTrends,
  listTrendRepos,
} from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';
export default async function TeamTrendsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  const { slug } = await params;
  const search = await searchParams;
  const window = parseReportRange(search);
  // A custom from/to window is not a preset — see the note on /org/trends.
  const custom = Boolean(search.from || search.to);
  const range = custom
    ? null
    : (([7, 30, 90].includes(window.days) ? window.days : 30) as 7 | 30 | 90);
  const { teamId, teamName } = await requireTeamLead(slug);
  const { visibleIds } = await resolveTeamVisibility(teamId);
  const since = window.start;
  const [points, scatter, concurrency, heatmap, repos] = await Promise.all([
    getTeamTrends(visibleIds, since, { repo: search.repo, until: window.end }),
    getTeamCostDuration(visibleIds, since, { repo: search.repo, until: window.end }),
    getTeamConcurrency(visibleIds, since, { repo: search.repo, until: window.end }),
    getTeamActivityHeatmap(visibleIds, since, window.end, window.timezone, search.repo),
    listTrendRepos(visibleIds),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        action={
          <ReportRangeControls
            basePath={`/team/${slug}/trends`}
            range={range}
            from={search.from}
            to={search.to}
            timezone={window.timezone}
            repo={search.repo}
            repos={repos}
          />
        }
        breadcrumb={teamName}
        description={`Daily activity and model mix · ${
          custom ? `${window.from} to ${window.to} (${window.days} days)` : `trailing ${range} days`
        }`}
        title="Trends"
      />
      {points.length === 0 ? (
        <EmptyState title="No activity in this period">
          Visible team sessions will appear here once members run an adapter.
        </EmptyState>
      ) : (
        <ScopedTrendCharts
          aggregateScatter
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
