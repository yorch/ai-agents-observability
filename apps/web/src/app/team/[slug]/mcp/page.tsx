import { EmptyState } from '@/components/team-org/EmptyState';
import { McpServerCard } from '@/components/team-org/McpServerCard';
import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { requireTeamLead } from '@/lib/roles';
import type { McpTeamDetailRow } from '@/lib/team-queries';
import { getTeamMcpDetails, resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { TeamSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function TeamMcpPage({
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
  const details = await getTeamMcpDetails(visibleIds, since);

  type ServerEntry = {
    distinctUsers: number;
    durationCount: number;
    durationSum: number;
    p95DurationMs: number | null;
    tools: McpTeamDetailRow[];
    totalCalls: number;
    totalCostUsd: number;
    totalDenies: number;
    totalErrors: number;
  };

  const serverMap = new Map<string, ServerEntry>();
  for (const row of details) {
    if (!serverMap.has(row.mcpServer)) {
      serverMap.set(row.mcpServer, {
        distinctUsers: row.serverDistinctUsers,
        durationCount: 0,
        durationSum: 0,
        p95DurationMs: null,
        tools: [],
        totalCalls: 0,
        totalCostUsd: 0,
        totalDenies: 0,
        totalErrors: 0,
      });
    }
    const entry = serverMap.get(row.mcpServer) as ServerEntry;
    entry.tools.push(row);
    entry.totalCalls += row.callCount;
    entry.totalDenies += row.denyCount;
    entry.totalErrors += row.errorCount;
    entry.totalCostUsd += row.totalCostUsd;
    if (row.avgDurationMs !== null) {
      entry.durationSum += row.avgDurationMs * row.callCount;
      entry.durationCount += row.callCount;
    }
    if (row.p95DurationMs !== null) {
      entry.p95DurationMs =
        entry.p95DurationMs === null
          ? row.p95DurationMs
          : Math.max(entry.p95DurationMs, row.p95DurationMs);
    }
  }

  const servers = [...serverMap.entries()].sort(([, a], [, b]) => b.totalCalls - a.totalCalls);

  const totalCalls = servers.reduce((s, [, v]) => s + v.totalCalls, 0);
  const totalUnhealthy = servers.reduce((s, [, v]) => s + v.totalErrors + v.totalDenies, 0);
  const overallErrorRate = totalCalls > 0 ? totalUnhealthy / totalCalls : 0;
  const totalCostUsd = servers.reduce((s, [, v]) => s + v.totalCostUsd, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`MCP integrations · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <TeamSubNav slug={slug} active="mcp" />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={`MCP calls (${range}d)`} value={totalCalls.toLocaleString()} />
        <StatCard label="Active servers" value={servers.length.toString()} />
        <StatCard
          label="Error / deny rate"
          value={totalCalls > 0 ? `${(overallErrorRate * 100).toFixed(1)}%` : '—'}
          warn={overallErrorRate > 0.05}
        />
        <StatCard
          label="Attributed LLM cost"
          value={totalCostUsd > 0 ? `$${totalCostUsd.toFixed(2)}` : '—'}
        />
      </div>

      {servers.length === 0 ? (
        <EmptyState>No MCP usage recorded in the last {range} days.</EmptyState>
      ) : (
        <div className="space-y-4">
          {servers.map(([server, data]) => {
            const errorRate =
              data.totalCalls > 0 ? (data.totalErrors + data.totalDenies) / data.totalCalls : 0;
            const avgDurationMs =
              data.durationCount > 0 ? Math.round(data.durationSum / data.durationCount) : null;
            return (
              <McpServerCard
                key={server}
                avgDurationMs={avgDurationMs}
                data={data}
                errorRate={errorRate}
                server={server}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
