import { ReportDigest } from '@/components/reports/ReportDigest';
import { getTeamReport } from '@/lib/reporting-queries';
import { reportDays } from '@/lib/reporting-route';
import { requireTeamLead } from '@/lib/roles';
import { resolveTeamVisibility } from '@/lib/team-queries';

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
  const report = await getTeamReport({
    days,
    teamLabel: teamName,
    totalMemberCount: visibility.totalCount,
    visibleIds: visibility.visibleIds,
  });
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
      <ReportDigest apiHref={`/api/team/${slug}/report?range=${days}`} report={report} />
    </div>
  );
}
