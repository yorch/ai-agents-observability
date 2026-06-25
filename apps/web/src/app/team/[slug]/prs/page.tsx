import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { TeamPrRollupTable } from '@/components/team-org/TeamPrRollupTable';
import { requireTeamLead } from '@/lib/roles';
import { getTeamPrRollups, resolveTeamVisibility } from '@/lib/team-queries';
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
  const prs = await getTeamPrRollups(since, visibleIds);

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

      <TeamPrRollupTable rows={prs} />
    </div>
  );
}
