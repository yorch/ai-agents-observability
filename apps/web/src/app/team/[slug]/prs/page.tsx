import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { TeamPrRollupTable } from '@/components/team-org/TeamPrRollupTable';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamPRDeliveryStats,
  getTeamPrRollups,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { TeamSubNav } from '../layout';

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
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Team</p>
          <h1 className="text-2xl font-semibold">{teamName}</h1>
          <p className="mt-1 text-sm text-white/50">Trailing {range} days</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <TeamSubNav slug={slug} active="prs" />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: 'PRs opened', value: delivery.totalPRs.toString() },
          { label: 'Merge rate', value: `${Math.round(delivery.mergeRate * 100)}%` },
          {
            label: 'Median time to merge',
            value: fmtHours(delivery.medianTimeToMergeHours),
          },
          {
            label: 'Avg cost / PR',
            value: delivery.avgCostPerPR > 0 ? `$${delivery.avgCostPerPR.toFixed(2)}` : '—',
          },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-xs text-white/40 uppercase tracking-wider">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold font-mono">{card.value}</p>
          </div>
        ))}
      </div>

      <TeamPrRollupTable rows={prs} />
    </div>
  );
}
