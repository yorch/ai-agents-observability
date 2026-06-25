import { redirect } from 'next/navigation';
import { FrictionTrendChart } from '@/components/me/FrictionTrendChart';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { currentUser } from '@/lib/auth';
import { getUserEffectiveness } from '@/lib/effectiveness-queries';
import {
  getMcpUsage,
  getSessionSummary,
  getSkillUsage,
  getSlashCommands,
  getSubagentUsage,
  getToolPerf,
  type McpUsageRow,
  type SessionSummaryRow,
  type SkillUsageRow,
  type SlashCommandRow,
  type SubagentUsageRow,
  type ToolPerfRow,
} from '@/lib/insights-queries';

export const dynamic = 'force-dynamic';

const DAYS_OPTS = [7, 30, 90] as const;
type Days = (typeof DAYS_OPTS)[number];

function parseDays(raw: string | undefined): Days {
  const n = Number(raw);
  return (DAYS_OPTS as readonly number[]).includes(n) ? (n as Days) : 30;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function pct(num: number, den: number): string {
  if (den === 0) {
    return '—';
  }
  return `${((num / den) * 100).toFixed(1)}%`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: bigint): string {
  const m = Number(n) / 1_000_000;
  if (m >= 1) {
    return `${m.toFixed(1)}M`;
  }
  const k = Number(n) / 1_000;
  if (k >= 1) {
    return `${k.toFixed(0)}k`;
  }
  return String(n);
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const days = parseDays(params.days);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [mcp, skills, slashCmds, subagents, toolPerf, effectiveness, summary] = await Promise.all([
    getMcpUsage(user.id, since),
    getSkillUsage(user.id, since),
    getSlashCommands(user.id, since),
    getSubagentUsage(user.id, since),
    getToolPerf(user.id, since),
    getUserEffectiveness(user.id, { since }),
    getSessionSummary(user.id, since),
  ]);

  const hasSessionData = summary.sessionCount > 0;
  const hasEventData =
    mcp.length > 0 ||
    skills.length > 0 ||
    slashCmds.length > 0 ||
    subagents.length > 0 ||
    toolPerf.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">Insights</h1>
          <p className="mt-1 text-sm text-text-2">
            Sessions · friction · shapes · MCP servers · tools
          </p>
        </div>
        <DaysSelector current={days} />
      </div>

      {!hasSessionData && !hasEventData ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-sm text-text-3">
            No data for the selected window. Run some sessions to see insights here.
          </p>
        </div>
      ) : (
        <>
          {hasSessionData && <SessionSummaryCards summary={summary} />}

          {hasSessionData && (
            <div className="grid gap-6 md:grid-cols-2">
              <FrictionTrendChart
                points={effectiveness.trend}
                scoredSessionCount={effectiveness.scoredSessionCount}
              />
              <ShapeDistributionChart histogram={effectiveness.shapeHistogram} />
            </div>
          )}

          {hasEventData && (
            <>
              <div className="grid gap-6 md:grid-cols-2">
                <McpSection rows={mcp} />
                <SkillsSection rows={skills} />
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <SlashCommandsSection rows={slashCmds} />
                <SubagentsSection rows={subagents} />
              </div>
              <ToolPerfSection rows={toolPerf} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function DaysSelector({ current }: { current: Days }) {
  return (
    <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
      {DAYS_OPTS.map((d) => (
        <a
          key={d}
          href={`/me/insights?days=${d}`}
          className={`rounded-md px-3 py-1 text-xs font-medium font-mono transition-colors ${
            current === d ? 'bg-accent text-bg' : 'text-text-3 hover:text-text hover:bg-surface-2'
          }`}
        >
          {d}d
        </a>
      ))}
    </div>
  );
}

function SessionSummaryCards({ summary: s }: { summary: SessionSummaryRow }) {
  const cards = [
    { label: 'Sessions', value: s.sessionCount.toLocaleString() },
    { label: 'Total cost', value: fmtCost(s.totalCostUsd) },
    { label: 'Avg cost / session', value: s.sessionCount > 0 ? fmtCost(s.avgCostUsd) : '—' },
    { label: 'Input tokens', value: fmtTokens(s.totalInputTokens) },
    { label: 'Output tokens', value: fmtTokens(s.totalOutputTokens) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map(({ label, value }) => (
        <div key={label} className="rounded-lg border border-border bg-surface px-4 py-3 space-y-1">
          <p className="text-xs text-text-3">{label}</p>
          <p className="text-lg font-semibold tabular-nums text-text">{value}</p>
        </div>
      ))}
    </div>
  );
}

function SectionShell({
  children,
  empty,
  title,
}: {
  children: React.ReactNode;
  empty: boolean;
  title: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">{title}</h2>
      {empty ? <p className="text-sm text-text-3">No data in this window.</p> : children}
    </section>
  );
}

function McpSection({ rows }: { rows: McpUsageRow[] }) {
  const servers = Array.from(new Set(rows.map((r) => r.mcpServer)));
  return (
    <SectionShell title="MCP servers" empty={rows.length === 0}>
      {servers.map((server) => {
        const serverRows = rows.filter((r) => r.mcpServer === server);
        const totalCalls = serverRows.reduce((s, r) => s + r.callCount, 0);
        const totalErrors = serverRows.reduce((s, r) => s + r.errorCount, 0);
        return (
          <div key={server} className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono font-medium text-text">{server}</span>
              <span className="text-text-3">
                {totalCalls} calls · {pct(totalErrors, totalCalls)} errors
              </span>
            </div>
            {serverRows
              .filter((r) => r.mcpTool)
              .map((r) => (
                <div
                  key={`${r.mcpServer}-${r.mcpTool}`}
                  className="ml-3 flex items-center justify-between text-xs text-text-2"
                >
                  <span className="font-mono">{r.mcpTool}</span>
                  <span className="text-text-3">
                    {r.callCount}×
                    {r.avgDurationMs != null && (
                      <span className="ml-2">{fmtDuration(r.avgDurationMs)}</span>
                    )}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
    </SectionShell>
  );
}

function SkillsSection({ rows }: { rows: SkillUsageRow[] }) {
  return (
    <SectionShell title="Skills" empty={rows.length === 0}>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div
            key={`${r.skillName}-${r.skillPath ?? ''}`}
            className="flex items-center justify-between text-sm"
          >
            <div>
              <span className="font-mono text-xs text-text">{r.skillName}</span>
              {r.skillPath && (
                <span className="ml-2 text-xs text-text-3 truncate max-w-[140px] inline-block align-bottom">
                  {r.skillPath}
                </span>
              )}
            </div>
            <span className="text-xs text-text-2">{r.useCount}×</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function SlashCommandsSection({ rows }: { rows: SlashCommandRow[] }) {
  const total = rows.reduce((s, r) => s + r.useCount, 0);
  return (
    <SectionShell title="Slash commands" empty={rows.length === 0}>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const barPct = total > 0 ? (r.useCount / total) * 100 : 0;
          return (
            <div key={r.command} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-text">{r.command}</span>
                <span className="text-text-3">{r.useCount}×</span>
              </div>
              <div className="h-1 rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent/50"
                  style={{ width: `${barPct.toFixed(1)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

function SubagentsSection({ rows }: { rows: SubagentUsageRow[] }) {
  const total = rows.reduce((s, r) => s + r.useCount, 0);
  return (
    <SectionShell title="Subagents spawned" empty={rows.length === 0}>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.subagentType} className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs text-text">{r.subagentType}</span>
            <div className="flex items-center gap-3 text-xs text-text-2">
              <span>{r.useCount}×</span>
              <span>{pct(r.useCount, total)}</span>
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function ToolPerfSection({ rows }: { rows: ToolPerfRow[] }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">
        Tool performance
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-text-3">No PostToolUse events in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-3 border-b border-border">
                <th className="pb-2 font-medium">Tool</th>
                <th className="pb-2 font-medium">Category</th>
                <th className="pb-2 font-medium text-right">Calls</th>
                <th className="pb-2 font-medium text-right">Errors</th>
                <th className="pb-2 font-medium text-right">Denied</th>
                <th className="pb-2 font-medium text-right">Avg</th>
                <th className="pb-2 font-medium text-right">p95</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((r) => (
                <tr key={r.toolName}>
                  <td className="py-2 font-mono text-xs text-text">{r.toolName}</td>
                  <td className="py-2 text-xs text-text-3">{r.toolCategory ?? '—'}</td>
                  <td className="py-2 text-right text-text-2">{r.callCount}</td>
                  <td
                    className={`py-2 text-right text-xs ${
                      r.errorCount > 0 ? 'text-red-400' : 'text-text-3'
                    }`}
                  >
                    {r.errorCount > 0 ? `${r.errorCount} (${pct(r.errorCount, r.callCount)})` : '—'}
                  </td>
                  <td
                    className={`py-2 text-right text-xs ${
                      r.deniedCount > 0 ? 'text-yellow-400' : 'text-text-3'
                    }`}
                  >
                    {r.deniedCount > 0 ? r.deniedCount : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-text-2">
                    {fmtDuration(r.avgDurationMs)}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-text-3">
                    {fmtDuration(r.p95DurationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
