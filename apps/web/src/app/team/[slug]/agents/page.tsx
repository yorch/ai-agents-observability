import { AgentsTable } from '@/components/team-org/AgentsTable';
import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { requireTeamLead } from '@/lib/roles';
import { getTeamSubagentStats, resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { TeamSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function TeamAgentsPage({
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
  const agents = await getTeamSubagentStats(visibleIds, since);

  const totalSpawns = agents.reduce((s, a) => s + a.spawnCount, 0);
  const totalCostUsd = agents.reduce((s, a) => s + a.totalCostUsd, 0);
  const distinctTypes = agents.filter((a) => a.subagentType !== null).length;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Sub-agent usage · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <TeamSubNav slug={slug} active="agents" />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={`Agent spawns (${range}d)`} value={totalSpawns.toLocaleString()} />
        <StatCard label="Agent types" value={distinctTypes.toString()} />
        <StatCard
          label="Attributed cost"
          value={totalCostUsd > 0 ? `$${totalCostUsd.toFixed(2)}` : '—'}
        />
        <StatCard
          label="Avg cost / spawn"
          value={
            totalSpawns > 0 && totalCostUsd > 0
              ? `$${(totalCostUsd / totalSpawns).toFixed(3)}`
              : '—'
          }
        />
      </div>

      {agents.length === 0 ? (
        <EmptyState>No sub-agent activity recorded in the last {range} days.</EmptyState>
      ) : (
        <AgentsTable agents={agents} totalSpawns={totalSpawns} />
      )}
    </div>
  );
}
