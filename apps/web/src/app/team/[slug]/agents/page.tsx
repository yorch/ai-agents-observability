import { AgentsTable } from '@/components/team-org/AgentsTable';
import { PageHeader } from '@/components/team-org/PageHeader';
import { EmptyState, Stat } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import { getTeamSubagentStats, resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

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
  const distinctTypes = agents.filter((a) => a.subagentType !== null).length;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Sub-agent usage · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={`Agent spawns (${range}d)`} value={totalSpawns.toLocaleString()} />
        <Stat label="Agent types" value={distinctTypes.toString()} />
        {/* Cost isn't attributed per tool event today (P14-003 will link it to
            turns); showing a computed sum here would present that gap as a
            real number instead of naming it. */}
        <Stat
          label="Attributed cost"
          sub="Requires turn-linked cost attribution"
          value="Not yet captured"
        />
        <Stat
          label="Avg cost / spawn"
          sub="Requires turn-linked cost attribution"
          value="Not yet captured"
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
