import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import {
  getMcpUsage,
  getSkillUsage,
  getSlashCommands,
  getSubagentUsage,
  getToolPerf,
  type McpUsageRow,
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
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pct(num: number, den: number): string {
  if (den === 0) return '—';
  return `${((num / den) * 100).toFixed(1)}%`;
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const days = parseDays(params.days);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [mcp, skills, slashCmds, subagents, toolPerf] = await Promise.all([
    getMcpUsage(user.id, since),
    getSkillUsage(user.id, since),
    getSlashCommands(user.id, since),
    getSubagentUsage(user.id, since),
    getToolPerf(user.id, since),
  ]);

  const hasAnyData =
    mcp.length > 0 ||
    skills.length > 0 ||
    slashCmds.length > 0 ||
    subagents.length > 0 ||
    toolPerf.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Insights</h1>
          <p className="mt-1 text-sm text-white/50">
            MCP servers · skills · commands · subagents · tool performance
          </p>
        </div>
        <DaysSelector current={days} />
      </div>

      {!hasAnyData ? (
        <div className="rounded-lg border border-white/10 p-8 text-center">
          <p className="text-sm text-white/50">
            No data for the selected window. Run some sessions to see insights here.
          </p>
        </div>
      ) : (
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
    </div>
  );
}

function DaysSelector({ current }: { current: Days }) {
  return (
    <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
      {DAYS_OPTS.map((d) => (
        <a
          key={d}
          href={`/me/insights?days=${d}`}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            current === d
              ? 'bg-brand-500 text-white'
              : 'text-white/50 hover:text-white hover:bg-white/10'
          }`}
        >
          {d}d
        </a>
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
    <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-white/70">{title}</h2>
      {empty ? (
        <p className="text-sm text-white/30">No data in this window.</p>
      ) : (
        children
      )}
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
              <span className="font-mono font-medium text-white/80">{server}</span>
              <span className="text-white/40">
                {totalCalls} calls · {pct(totalErrors, totalCalls)} errors
              </span>
            </div>
            {serverRows
              .filter((r) => r.mcpTool)
              .map((r) => (
                <div
                  key={`${r.mcpServer}-${r.mcpTool}`}
                  className="ml-3 flex items-center justify-between text-xs text-white/60"
                >
                  <span className="font-mono">{r.mcpTool}</span>
                  <span className="text-white/40">
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
              <span className="font-mono text-xs text-white/80">{r.skillName}</span>
              {r.skillPath && (
                <span className="ml-2 text-xs text-white/30 truncate max-w-[140px] inline-block align-bottom">
                  {r.skillPath}
                </span>
              )}
            </div>
            <span className="text-xs text-white/50">{r.useCount}×</span>
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
                <span className="font-mono text-white/80">{r.command}</span>
                <span className="text-white/40">{r.useCount}×</span>
              </div>
              <div className="h-1 rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-brand-500/60"
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
            <span className="font-mono text-xs text-white/80">{r.subagentType}</span>
            <div className="flex items-center gap-3 text-xs text-white/50">
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
    <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-white/70">Tool performance</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-white/30">No PostToolUse events in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-white/40 border-b border-white/10">
                <th className="pb-2 font-medium">Tool</th>
                <th className="pb-2 font-medium">Category</th>
                <th className="pb-2 font-medium text-right">Calls</th>
                <th className="pb-2 font-medium text-right">Errors</th>
                <th className="pb-2 font-medium text-right">Denied</th>
                <th className="pb-2 font-medium text-right">Avg</th>
                <th className="pb-2 font-medium text-right">p95</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.toolName}>
                  <td className="py-2 font-mono text-xs text-white/80">{r.toolName}</td>
                  <td className="py-2 text-xs text-white/40">{r.toolCategory ?? '—'}</td>
                  <td className="py-2 text-right text-white/60">{r.callCount}</td>
                  <td
                    className={`py-2 text-right text-xs ${
                      r.errorCount > 0 ? 'text-red-400' : 'text-white/30'
                    }`}
                  >
                    {r.errorCount > 0 ? `${r.errorCount} (${pct(r.errorCount, r.callCount)})` : '—'}
                  </td>
                  <td
                    className={`py-2 text-right text-xs ${
                      r.deniedCount > 0 ? 'text-yellow-400' : 'text-white/30'
                    }`}
                  >
                    {r.deniedCount > 0 ? r.deniedCount : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-white/60">
                    {fmtDuration(r.avgDurationMs)}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-white/50">
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
