import { AgentsTable } from '@/components/team-org/AgentsTable';
import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { getOrgSubagentStats } from '@/lib/org-queries';
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
  const agents = await getOrgSubagentStats(since);

  const totalSpawns = agents.reduce((s, a) => s + a.spawnCount, 0);
  const totalCostUsd = agents.reduce((s, a) => s + a.totalCostUsd, 0);
  const distinctTypes = agents.filter((a) => a.subagentType !== null).length;

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days · agent spawns across the org`}
        range={range}
        title="Sub-agent Usage"
      />

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
