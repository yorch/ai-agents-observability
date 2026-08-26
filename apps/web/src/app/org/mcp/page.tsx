import { McpServerCard } from '@/components/team-org/McpServerCard';
import { PageHeader } from '@/components/team-org/PageHeader';
import { SubjectQualityPanel } from '@/components/team-org/SubjectQualityPanel';
import { Card, Cell, EmptyState, Row, Stat, Table } from '@/components/ui';
import { fmtDurationOrDash } from '@/lib/fmt';
import { getMcpServerDetails, type McpServerDetailRow, orgVisibleUserIds } from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import {
  getMcpFailureSplit,
  getMcpQuality,
  getSubjectScoreSeries,
} from '@/lib/subject-quality-queries';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

export default async function OrgMcpPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const visibleIds = await orgVisibleUserIds(since);
  const [details, quality, failureSplit] = await Promise.all([
    getMcpServerDetails(since),
    getMcpQuality(visibleIds, since),
    getMcpFailureSplit(visibleIds, since),
  ]);

  // Group rows by server, computing server-level aggregates
  type ServerEntry = {
    distinctUsers: number;
    durationCount: number;
    durationSum: number;
    p95DurationMs: number | null;
    tools: McpServerDetailRow[];
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

  // The stored series behind the error-rate column (P13-013). Keyed the same
  // way `scores.subject_id` is, so the panel needs no id-shaping of its own.
  const qualitySeries = await getSubjectScoreSeries('MCP_SERVER', quality);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days · server health, latency, and attributed LLM cost`}
        range={range}
        title="MCP Integrations"
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={`MCP calls (${range}d)`} value={totalCalls.toLocaleString()} />
        <Stat label="Active servers" value={servers.length.toString()} />
        <Stat
          label="Error / deny rate"
          value={totalCalls > 0 ? `${(overallErrorRate * 100).toFixed(1)}%` : '—'}
          accent={overallErrorRate > 0.05 ? 'warn' : undefined}
        />
        {/* Cost isn't attributed per tool event today (P14-003 will link it to
            turns); showing a computed sum here would present that gap as a
            real number instead of naming it. */}
        <Stat
          label="Attributed LLM cost"
          sub="Requires turn-linked cost attribution"
          value="Not yet captured"
        />
      </div>

      <SubjectQualityPanel
        caption={`How sessions that used each server compare with matched sessions that did not, over the trailing ${range} days.`}
        rows={quality}
        series={qualitySeries}
        subjectNoun="MCP server"
        title="Effectiveness"
      />

      {failureSplit.length > 0 && (
        <Card
          caption="A non-zero exit that returned no payload at all did not reach a tool — that is the server. One that returned a payload is the tool's own error. The two need different owners, so they are never summed into one rate."
          flush
          title="Failure attribution"
        >
          <div className="px-4 pb-4">
            <Table
              columns={[
                { label: 'Server' },
                { align: 'right', label: 'Calls', mono: true },
                { align: 'right', label: 'Server unavailable', mono: true },
                { align: 'right', label: 'Tool returned error', mono: true },
                { align: 'right', label: 'p95 duration', mono: true },
              ]}
            >
              {failureSplit.map((r) => (
                <Row key={r.mcpServer}>
                  <Cell>
                    <span className="font-mono text-text">{r.mcpServer}</span>
                  </Cell>
                  <Cell num className="text-text-2">
                    {r.calls.toLocaleString()}
                  </Cell>
                  <Cell num className="text-text-2">
                    {r.unavailable.toLocaleString()}
                  </Cell>
                  <Cell num className="text-text-2">
                    {r.toolErrors.toLocaleString()}
                  </Cell>
                  <Cell num className="text-text-2">
                    {fmtDurationOrDash(r.p95DurationMs)}
                  </Cell>
                </Row>
              ))}
            </Table>
          </div>
        </Card>
      )}

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
