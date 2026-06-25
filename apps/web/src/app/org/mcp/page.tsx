import { getMcpServerDetails, type McpServerDetailRow } from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
import { OrgSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function OrgMcpPage() {
  await requireOrgViewer();

  const since = daysAgo(30);
  const details = await getMcpServerDetails(since);

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

  // Summary stats
  const totalCalls = servers.reduce((s, [, v]) => s + v.totalCalls, 0);
  const totalUnhealthy = servers.reduce((s, [, v]) => s + v.totalErrors + v.totalDenies, 0);
  const overallErrorRate = totalCalls > 0 ? totalUnhealthy / totalCalls : 0;
  const totalCostUsd = servers.reduce((s, [, v]) => s + v.totalCostUsd, 0);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Org</p>
        <h1 className="text-2xl font-semibold">MCP Integrations</h1>
        <p className="mt-1 text-sm text-white/50">
          Trailing 30 days · server health, latency, and attributed LLM cost
        </p>
      </div>

      <OrgSubNav active="mcp" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="MCP calls (30d)" value={totalCalls.toLocaleString()} />
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
        <div className="rounded-lg border border-white/10 bg-white/5 p-10 text-center text-sm text-white/40">
          No MCP usage recorded in the last 30 days.
        </div>
      ) : (
        <div className="space-y-4">
          {servers.map(([server, data]) => {
            const errorRate =
              data.totalCalls > 0 ? (data.totalErrors + data.totalDenies) / data.totalCalls : 0;
            const avgDurationMs =
              data.durationCount > 0 ? Math.round(data.durationSum / data.durationCount) : null;
            return (
              <ServerCard
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

function healthProps(errorRate: number): { dotCls: string; label: string; textCls: string } {
  if (errorRate < 0.05) {
    return { dotCls: 'bg-emerald-400', label: 'healthy', textCls: 'text-emerald-400' };
  }
  if (errorRate < 0.15) {
    return { dotCls: 'bg-yellow-400', label: 'degraded', textCls: 'text-yellow-300' };
  }
  return { dotCls: 'bg-red-400', label: 'unhealthy', textCls: 'text-red-400' };
}

function ServerCard({
  avgDurationMs,
  data,
  errorRate,
  server,
}: {
  avgDurationMs: number | null;
  data: {
    distinctUsers: number;
    p95DurationMs: number | null;
    tools: McpServerDetailRow[];
    totalCalls: number;
    totalCostUsd: number;
    totalDenies: number;
    totalErrors: number;
  };
  errorRate: number;
  server: string;
}) {
  const health = healthProps(errorRate);

  return (
    <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
      {/* Server header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 flex-shrink-0 rounded-full ${health.dotCls}`}
            title={health.label}
          />
          <span className="font-mono text-sm font-semibold text-white/90">{server}</span>
          <span className={`text-[10px] font-mono ${health.textCls}`}>{health.label}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-white/40">
          <span>{data.totalCalls.toLocaleString()} calls</span>
          <span>
            {data.distinctUsers} user{data.distinctUsers !== 1 ? 's' : ''}
          </span>
          {data.totalCostUsd > 0 && (
            <span className="font-mono text-white/60">
              ${data.totalCostUsd.toFixed(3)} attributed
            </span>
          )}
        </div>
      </div>

      {/* Metric pills */}
      <div className="flex flex-wrap gap-2">
        <MetricPill
          accent={errorRate >= 0.15 ? 'red' : errorRate >= 0.05 ? 'amber' : 'none'}
          label="error rate"
          value={`${(errorRate * 100).toFixed(1)}%`}
        />
        {avgDurationMs !== null && <MetricPill label="avg latency" value={fmtMs(avgDurationMs)} />}
        {data.p95DurationMs !== null && (
          <MetricPill label="p95 latency" value={fmtMs(data.p95DurationMs)} />
        )}
        <MetricPill
          accent={data.totalDenies > 0 ? 'amber' : 'none'}
          label="denies"
          value={data.totalDenies.toString()}
        />
        <MetricPill
          accent={data.totalErrors > 0 ? 'red' : 'none'}
          label="errors"
          value={data.totalErrors.toString()}
        />
      </div>

      {/* Per-tool breakdown */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-white/30">
              <th className="pb-2 font-medium">Tool</th>
              <th className="pb-2 text-right font-medium">Calls</th>
              <th className="pb-2 text-right font-medium">Errors</th>
              <th className="pb-2 text-right font-medium">Denies</th>
              <th className="pb-2 text-right font-medium">Avg ms</th>
              <th className="pb-2 text-right font-medium">p95 ms</th>
              <th className="pb-2 text-right font-medium">Users</th>
              <th className="pb-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {data.tools.map((t) => (
              <tr key={`${t.mcpServer}/${t.mcpTool ?? '__svr__'}`}>
                <td className="py-1.5 pr-4">
                  <span className="font-mono text-white/70">
                    {t.mcpTool ?? <span className="italic text-white/30">server-level</span>}
                  </span>
                </td>
                <td className="py-1.5 text-right font-mono text-white/60">
                  {t.callCount.toLocaleString()}
                </td>
                <td className="py-1.5 text-right font-mono">
                  <span className={t.errorCount > 0 ? 'text-red-400' : 'text-white/25'}>
                    {t.errorCount}
                  </span>
                </td>
                <td className="py-1.5 text-right font-mono">
                  <span className={t.denyCount > 0 ? 'text-yellow-300' : 'text-white/25'}>
                    {t.denyCount}
                  </span>
                </td>
                <td className="py-1.5 text-right font-mono text-white/50">
                  {t.avgDurationMs !== null ? fmtMs(t.avgDurationMs) : '—'}
                </td>
                <td className="py-1.5 text-right font-mono text-white/50">
                  {t.p95DurationMs !== null ? fmtMs(t.p95DurationMs) : '—'}
                </td>
                <td className="py-1.5 text-right text-white/50">{t.distinctUsers}</td>
                <td className="py-1.5 text-right font-mono text-white/50">
                  {t.totalCostUsd > 0 ? `$${t.totalCostUsd.toFixed(3)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricPill({
  accent = 'none',
  label,
  value,
}: {
  accent?: 'amber' | 'none' | 'red';
  label: string;
  value: string;
}) {
  const valueCls =
    accent === 'red' ? 'text-red-400' : accent === 'amber' ? 'text-yellow-300' : 'text-white/70';
  return (
    <div className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-2 py-0.5">
      <span className="text-[10px] uppercase tracking-wide text-white/30">{label}</span>
      <span className={`text-xs font-mono font-medium ${valueCls}`}>{value}</span>
    </div>
  );
}

function StatCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="space-y-1 rounded-lg border border-white/10 bg-white/5 p-4">
      <p className="text-xs text-white/50">{label}</p>
      <p className={`text-2xl font-semibold ${warn ? 'text-yellow-300' : ''}`}>{value}</p>
    </div>
  );
}

function fmtMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}
