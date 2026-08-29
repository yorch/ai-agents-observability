import { PageHeader } from '@/components/team-org/PageHeader';
import { TeamPrRollupTable } from '@/components/team-org/TeamPrRollupTable';
import { Stat } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { fmtHoursShort } from '@/lib/fmt';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamPRDeliveryStats,
  getTeamPrRollups,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function TeamPrsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const { teamId, teamName } = await requireTeamLead(slug);
  const { dict } = await getTranslations();
  const since = daysAgo(range);

  const { visibleIds } = await resolveTeamVisibility(teamId);
  const [prs, delivery] = await Promise.all([
    getTeamPrRollups(since, visibleIds),
    getTeamPRDeliveryStats(visibleIds, since),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={dict.team.prs.prsOpened} value={delivery.totalPRs.toString()} />
        <Stat label={dict.team.prs.mergeRate} value={`${Math.round(delivery.mergeRate * 100)}%`} />
        <Stat
          label={dict.team.prs.medianTimeToMerge}
          value={fmtHoursShort(delivery.medianTimeToMergeHours)}
        />
        <Stat
          label={dict.team.prs.avgCostPerPr}
          value={delivery.avgCostPerPR > 0 ? `$${delivery.avgCostPerPR.toFixed(2)}` : '—'}
        />
      </div>

      <TeamPrRollupTable rows={prs} />
    </div>
  );
}
