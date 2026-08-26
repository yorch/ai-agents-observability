import { AgentComparisonTable } from '@/components/team-org/AgentComparisonTable';
import { AgentsTable } from '@/components/team-org/AgentsTable';
import { PageHeader } from '@/components/team-org/PageHeader';
import { EmptyState, Stat } from '@/components/ui';
import { getAgentTypeComparison, getOrgSubagentStats } from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

export default async function OrgAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const [agents, agentComparison] = await Promise.all([
    getOrgSubagentStats(since),
    getAgentTypeComparison(since),
  ]);

  const totalSpawns = agents.reduce((s, a) => s + a.spawnCount, 0);
  const distinctTypes = agents.filter((a) => a.subagentType !== null).length;

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days · agent comparison and sub-agent usage`}
        range={range}
        title="Agents"
      />

      <AgentComparisonTable rows={agentComparison} />

      <h2 className="pt-2 text-sm font-semibold text-text-2">Sub-agent usage</h2>

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
