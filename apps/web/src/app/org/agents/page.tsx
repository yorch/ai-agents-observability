import { CostAttributionNote } from '@/components/CostAttributionNote';
import { AgentComparisonTable } from '@/components/team-org/AgentComparisonTable';
import { AgentsTable } from '@/components/team-org/AgentsTable';
import { PageHeader } from '@/components/team-org/PageHeader';
import { EmptyState, Stat } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { getAttributionCoverage, sumAttributed } from '@/lib/attribution-coverage';
import { fmtUsdOrDash } from '@/lib/fmt';
import { getAgentTypeComparison, getOrgSubagentStats, orgVisibleUserIds } from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

export default async function OrgAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { dict } = await getTranslations();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const visibleIds = await orgVisibleUserIds(since);
  const [agents, agentComparison, coverage] = await Promise.all([
    getOrgSubagentStats(since),
    getAgentTypeComparison(since),
    getAttributionCoverage(visibleIds, since),
  ]);

  const totalSpawns = agents.reduce((s, a) => s + a.spawnCount, 0);
  const distinctTypes = agents.filter((a) => a.subagentType !== null).length;
  // Nullable on purpose: a window with no turn linkage has no attributed cost,
  // which is a different claim from $0.00 and must not be rendered as one.
  const attributed = sumAttributed(agents.map((a) => a.attributedCostUsd));
  const downstream = sumAttributed(agents.map((a) => a.downstreamCostUsd));

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days · agent comparison and sub-agent usage`}
        range={range}
        title={dict.org.agents.title}
      />

      <AgentComparisonTable rows={agentComparison} />

      <h2 className="pt-2 text-sm font-semibold text-text-2">{dict.org.agents.subAgentUsage}</h2>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={`Agent spawns (${range}d)`} value={totalSpawns.toLocaleString()} />
        <Stat label={dict.org.agents.agentTypes} value={distinctTypes.toString()} />
        {/* P14-004. Two lenses on the same dollars, never a total — hence two
            tiles with distinct labels rather than one "cost" figure. */}
        <Stat
          label={dict.org.agents.turnShareCost}
          sub="Issuing turn's cost, split across its tool calls"
          value={fmtUsdOrDash(attributed)}
        />
        <Stat
          label={dict.org.agents.downstreamCost}
          sub="Input-side cost their output added to the next turn"
          value={fmtUsdOrDash(downstream)}
        />
      </div>

      <CostAttributionNote coverage={coverage} />

      {agents.length === 0 ? (
        <EmptyState>{format(dict.org.agents.empty, { range })}</EmptyState>
      ) : (
        <AgentsTable agents={agents} totalSpawns={totalSpawns} />
      )}
    </div>
  );
}
