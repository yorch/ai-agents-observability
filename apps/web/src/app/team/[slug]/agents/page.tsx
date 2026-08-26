import { CostAttributionNote } from '@/components/CostAttributionNote';
import { AgentsTable } from '@/components/team-org/AgentsTable';
import { PageHeader } from '@/components/team-org/PageHeader';
import { EmptyState, Stat } from '@/components/ui';
import { getAttributionCoverage, sumAttributed } from '@/lib/attribution-coverage';
import { fmtUsdOrDash } from '@/lib/fmt';
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
  const [agents, coverage] = await Promise.all([
    getTeamSubagentStats(visibleIds, since),
    getAttributionCoverage(visibleIds, since),
  ]);

  const totalSpawns = agents.reduce((s, a) => s + a.spawnCount, 0);
  const distinctTypes = agents.filter((a) => a.subagentType !== null).length;
  const attributed = sumAttributed(agents.map((a) => a.attributedCostUsd));
  const downstream = sumAttributed(agents.map((a) => a.downstreamCostUsd));

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
        {/* P14-004. Two lenses on the same dollars, never a total — hence two
            tiles with distinct labels rather than one "cost" figure. */}
        <Stat
          label="Turn-share cost"
          sub="Issuing turn's cost, split across its tool calls"
          value={fmtUsdOrDash(attributed)}
        />
        <Stat
          label="Downstream cost"
          sub="Input-side cost their output added to the next turn"
          value={fmtUsdOrDash(downstream)}
        />
      </div>

      <CostAttributionNote coverage={coverage} />

      {agents.length === 0 ? (
        <EmptyState>No sub-agent activity recorded in the last {range} days.</EmptyState>
      ) : (
        <AgentsTable agents={agents} totalSpawns={totalSpawns} />
      )}
    </div>
  );
}
