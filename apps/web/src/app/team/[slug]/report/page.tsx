import { ReportDigest } from '@/components/reports/ReportDigest';
import { PageHeader } from '@/components/team-org/PageHeader';
import { getTeamReport } from '@/lib/reporting-queries';
import { requireTeamLead } from '@/lib/roles';
import { getTeamCostDuration } from '@/lib/scatter-queries';
import { resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { getTeamActivityHeatmap, getTeamConcurrency, getTeamTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

// One trailing window, read by the digest, the charts and the download alike.
// See the note on /org/report for why an arbitrary from/to has no meaning for a
// period-over-period digest, and why those belong on the trends pages instead.
export default async function TeamReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ slug }, { range: rangeParam }] = await Promise.all([params, searchParams]);
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const { teamId, teamName } = await requireTeamLead(slug);
  const visibility = await resolveTeamVisibility(teamId);

  const since = daysAgo(range);
  const until = new Date();
  const options = { timezone: 'UTC', until };

  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getTeamReport({
      days: range,
      teamLabel: teamName,
      totalMemberCount: visibility.totalCount,
      visibleIds: visibility.visibleIds,
    }),
    getTeamTrends(visibility.visibleIds, since, options),
    getTeamCostDuration(visibility.visibleIds, since, options),
    getTeamConcurrency(visibility.visibleIds, since, options),
    getTeamActivityHeatmap(visibility.visibleIds, since, until, 'UTC', undefined),
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
      <PageHeader
        breadcrumb="Team"
        description="Aggregate activity only; team privacy settings are applied."
        range={range}
        title={`${teamName} report`}
      />
      <ReportDigest
        apiHref={`/api/team/${slug}/report?range=${range}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        drilldownHref={`/team/${slug}/sessions?from=${report.period.start}&to=${report.period.end}`}
        aggregateScatter
      />
    </div>
  );
}
