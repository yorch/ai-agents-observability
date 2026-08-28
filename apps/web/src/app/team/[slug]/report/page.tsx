import { ReportDigest } from '@/components/reports/ReportDigest';
import { getTeamReport } from '@/lib/reporting-queries';
import { parseReportRange } from '@/lib/reporting-range';
import { requireTeamLead } from '@/lib/roles';
import { getTeamCostDuration } from '@/lib/scatter-queries';
import { resolveTeamVisibility } from '@/lib/team-queries';
import { getTeamActivityHeatmap, getTeamConcurrency, getTeamTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export default async function TeamReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const window = parseReportRange(search);
  const days = window.days;
  const { teamId, teamName } = await requireTeamLead(slug);
  const visibility = await resolveTeamVisibility(teamId);
  const since = window.start;
  const options = { repo: search.repo, timezone: window.timezone, until: window.end };
  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getTeamReport({
      days,
      teamLabel: teamName,
      totalMemberCount: visibility.totalCount,
      visibleIds: visibility.visibleIds,
    }),
    getTeamTrends(visibility.visibleIds, since, options),
    getTeamCostDuration(visibility.visibleIds, since, options),
    getTeamConcurrency(visibility.visibleIds, since, options),
    getTeamActivityHeatmap(visibility.visibleIds, since, window.end, window.timezone, search.repo),
  ]);
  report.analytics = {
    concurrency: concurrency.map((p) => ({ ...p, day: p.day.toISOString().slice(0, 10) })),
    heatmap,
    scatter,
    trends: trends.map((p) => ({
      costUsd: p.costUsd,
      day: p.day.toISOString().slice(0, 10),
      sessionCount: p.sessionCount,
    })),
  };
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wider text-text-3">Team</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          {teamName} report
        </h1>
        <p className="mt-1 text-sm text-text-2">
          Aggregate activity only; team privacy settings are applied.
        </p>
      </div>
      <ReportDigest
        apiHref={`/api/team/${slug}/report?range=${days}${search.repo ? `&repo=${encodeURIComponent(search.repo)}` : ''}${search.from ? `&from=${search.from}` : ''}${search.to ? `&to=${search.to}` : ''}${search.tz ? `&tz=${encodeURIComponent(search.tz)}` : ''}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        drilldownHref={`/team/${slug}/sessions?from=${window.from}&to=${window.to}${search.repo ? `&repo=${encodeURIComponent(search.repo)}` : ''}`}
        aggregateScatter
      />
    </div>
  );
}
