import { Cell, Row, Table } from '@/components/ui';
import { fmtDuration } from '@/lib/fmt';

export type McpToolRow = {
  avgDurationMs: number | null;
  callCount: number;
  denyCount: number;
  distinctUsers: number;
  errorCount: number;
  mcpTool: string | null;
  p95DurationMs: number | null;
  totalCostUsd: number;
};

type ServerData = {
  distinctUsers: number;
  p95DurationMs: number | null;
  tools: McpToolRow[];
  totalCalls: number;
  totalCostUsd: number;
  totalDenies: number;
  totalErrors: number;
};

function healthProps(errorRate: number): { dotCls: string; label: string; textCls: string } {
  if (errorRate < 0.05) {
    return { dotCls: 'bg-good', label: 'healthy', textCls: 'text-good' };
  }
  if (errorRate < 0.15) {
    return { dotCls: 'bg-warn', label: 'degraded', textCls: 'text-warn' };
  }
  return { dotCls: 'bg-crit', label: 'unhealthy', textCls: 'text-crit' };
}

export function McpServerCard({
  avgDurationMs,
  data,
  errorRate,
  server,
}: {
  avgDurationMs: number | null;
  data: ServerData;
  errorRate: number;
  server: string;
}) {
  const health = healthProps(errorRate);
  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 flex-shrink-0 rounded-full ${health.dotCls}`}
            title={health.label}
          />
          <span className="font-mono text-sm font-semibold text-text">{server}</span>
          <span className={`text-[10px] font-mono ${health.textCls}`}>{health.label}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-text-3">
          <span>{data.totalCalls.toLocaleString()} calls</span>
          <span>
            {data.distinctUsers} user{data.distinctUsers !== 1 ? 's' : ''}
          </span>
          {data.totalCostUsd > 0 && (
            <span className="font-mono text-text-2">
              ${data.totalCostUsd.toFixed(3)} attributed
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <MetricPill
          accent={errorRate >= 0.15 ? 'crit' : errorRate >= 0.05 ? 'warn' : 'none'}
          label="error rate"
          value={`${(errorRate * 100).toFixed(1)}%`}
        />
        {avgDurationMs !== null && (
          <MetricPill label="avg latency" value={fmtDuration(avgDurationMs)} />
        )}
        {data.p95DurationMs !== null && (
          <MetricPill label="p95 latency" value={fmtDuration(data.p95DurationMs)} />
        )}
        <MetricPill
          accent={data.totalDenies > 0 ? 'warn' : 'none'}
          label="denies"
          value={data.totalDenies.toString()}
        />
        <MetricPill
          accent={data.totalErrors > 0 ? 'crit' : 'none'}
          label="errors"
          value={data.totalErrors.toString()}
        />
      </div>

      <Table
        columns={[
          { label: 'Tool' },
          { align: 'right', label: 'Calls' },
          { align: 'right', label: 'Errors' },
          { align: 'right', label: 'Denies' },
          { align: 'right', label: 'Avg ms' },
          { align: 'right', label: 'p95 ms' },
          { align: 'right', label: 'Users' },
          { align: 'right', label: 'Cost' },
        ]}
      >
        {data.tools.map((t) => (
          <Row key={`${server}/${t.mcpTool ?? '__svr__'}`}>
            <Cell>
              <span className="font-mono text-text-2">
                {t.mcpTool ?? <span className="italic text-text-3">server-level</span>}
              </span>
            </Cell>
            <Cell num className="text-text-2">
              {t.callCount.toLocaleString()}
            </Cell>
            <Cell num>
              <span className={t.errorCount > 0 ? 'text-crit' : 'text-text-3'}>{t.errorCount}</span>
            </Cell>
            <Cell num>
              <span className={t.denyCount > 0 ? 'text-warn' : 'text-text-3'}>{t.denyCount}</span>
            </Cell>
            <Cell num className="text-text-2">
              {t.avgDurationMs !== null ? fmtDuration(t.avgDurationMs) : '—'}
            </Cell>
            <Cell num className="text-text-2">
              {t.p95DurationMs !== null ? fmtDuration(t.p95DurationMs) : '—'}
            </Cell>
            <Cell num className="text-text-2">
              {t.distinctUsers}
            </Cell>
            <Cell num className="text-text-2">
              {t.totalCostUsd > 0 ? `$${t.totalCostUsd.toFixed(3)}` : '—'}
            </Cell>
          </Row>
        ))}
      </Table>
    </section>
  );
}

export function MetricPill({
  accent = 'none',
  label,
  value,
}: {
  accent?: 'crit' | 'none' | 'warn';
  label: string;
  value: string;
}) {
  const valueCls =
    accent === 'crit' ? 'text-crit' : accent === 'warn' ? 'text-warn' : 'text-text-2';
  return (
    <div className="flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-0.5">
      <span className="text-[10px] uppercase tracking-wide text-text-3">{label}</span>
      <span className={`text-xs font-mono font-medium ${valueCls}`}>{value}</span>
    </div>
  );
}
