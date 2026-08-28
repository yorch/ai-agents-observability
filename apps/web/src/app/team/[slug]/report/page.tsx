import { ReportDigest } from '@/components/reports/ReportDigest';
import { getTeamReport } from '@/lib/reporting-queries';
import { reportDays } from '@/lib/reporting-route';
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
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ slug }, { range }] = await Promise.all([params, searchParams]);
  const days = reportDays(range ?? null);
  const { teamId, teamName } = await requireTeamLead(slug);
  const visibility = await resolveTeamVisibility(teamId);
  const since = new Date(Date.now() - days * 86_400_000);
  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getTeamReport({
      days,
      teamLabel: teamName,
      totalMemberCount: visibility.totalCount,
      visibleIds: visibility.visibleIds,
    }),
    getTeamTrends(visibility.visibleIds, since),
    getTeamCostDuration(visibility.visibleIds, since),
    getTeamConcurrency(visibility.visibleIds, since),
    getTeamActivityHeatmap(visibility.visibleIds, since),
  ]);
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
        apiHref={`/api/team/${slug}/report?range=${days}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        aggregateScatter
      />
    </div>
  );
}
