import { PageHeader } from '@/components/team-org/PageHeader';
import { TeamPrRollupTable } from '@/components/team-org/TeamPrRollupTable';
import { Stat } from '@/components/ui';
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
  const since = daysAgo(range);

  const { visibleIds } = await resolveTeamVisibility(teamId);
  const [prs, delivery] = await Promise.all([
    getTeamPrRollups(since, visibleIds),
    getTeamPRDeliveryStats(visibleIds, since),
  ]);

  const fmtHours = (h: number | null) => {
    if (h === null) {
      return '—';
    }
    if (h < 24) {
      return `${h.toFixed(1)}h`;
    }
    return `${(h / 24).toFixed(1)}d`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="PRs opened" value={delivery.totalPRs.toString()} />
        <Stat label="Merge rate" value={`${Math.round(delivery.mergeRate * 100)}%`} />
        <Stat label="Median time to merge" value={fmtHours(delivery.medianTimeToMergeHours)} />
        <Stat
          label="Avg cost / PR"
          value={delivery.avgCostPerPR > 0 ? `$${delivery.avgCostPerPR.toFixed(2)}` : '—'}
        />
      </div>

      <TeamPrRollupTable rows={prs} />
    </div>
  );
}
