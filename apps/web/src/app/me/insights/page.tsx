import { redirect } from 'next/navigation';
import { FrictionTrendChart } from '@/components/me/FrictionTrendChart';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { currentUser } from '@/lib/auth';
import { getUserEffectiveness } from '@/lib/effectiveness-queries';
import {
  getMcpUsage,
  getSessionSummary,
  getSkillOutcomes,
  getSkillSequences,
  getSkillSubagents,
  getSkillTrend,
  getSkillUsage,
  getSlashCommands,
  getSubagentUsage,
  getToolPerf,
  type McpUsageRow,
  type SessionSummaryRow,
  type SkillOutcomeRow,
  type SkillSequenceRow,
  type SkillSubagentRow,
  type SkillTrendRow,
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

  const [
    mcp,
    skills,
    skillOutcomes,
    skillTrend,
    skillSubagents,
    skillSequences,
    slashCmds,
    subagents,
    toolPerf,
    effectiveness,
    summary,
  ] = await Promise.all([
    getMcpUsage(user.id, since),
    getSkillUsage(user.id, since),
    getSkillOutcomes(user.id, since),
    getSkillTrend(user.id, since),
    getSkillSubagents(user.id, since),
    getSkillSequences(user.id, since),
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
            Sessions · friction · shapes · MCP servers · tools · skills
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
                <SlashCommandsSection rows={slashCmds} />
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <SubagentsSection rows={subagents} />
                <ToolPerfSection rows={toolPerf} />
              </div>

              {skills.length > 0 && (
                <SkillsSection
                  rows={skills}
                  outcomes={skillOutcomes}
                  trend={skillTrend}
                  subagents={skillSubagents}
                />
              )}

              {skillSequences.length > 0 && <SkillSequencesSection rows={skillSequences} />}
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

const STATUS_COLORS: Record<string, string> = {
  ABANDONED: 'bg-yellow-500/20 text-yellow-400',
  COMPLETED: 'bg-emerald-500/20 text-emerald-400',
  ERROR: 'bg-red-500/20 text-red-400',
};

function SkillsSection({
  rows,
  outcomes,
  trend,
  subagents,
}: {
  outcomes: SkillOutcomeRow[];
  rows: SkillUsageRow[];
  subagents: SkillSubagentRow[];
  trend: SkillTrendRow[];
}) {
  // Index outcomes and subagents by skillName for fast lookup
  const outcomesBySkill = new Map<string, SkillOutcomeRow[]>();
  for (const o of outcomes) {
    if (!outcomesBySkill.has(o.skillName)) {
      outcomesBySkill.set(o.skillName, []);
    }
    outcomesBySkill.get(o.skillName)?.push(o);
  }
  const subagentBySkill = new Map(subagents.map((s) => [s.skillName, s]));

  // Build a mini daily trend sparkline per skill
  const days = Array.from(new Set(trend.map((t) => t.day.toISOString()))).sort();
  const trendBySkill = new Map<string, number[]>();
  for (const r of rows) {
    const counts = days.map((d) => {
      const match = trend.find((t) => t.skillName === r.skillName && t.day.toISOString() === d);
      return match?.useCount ?? 0;
    });
    trendBySkill.set(r.skillName, counts);
  }

  const maxCalls = Math.max(...rows.map((r) => r.useCount), 1);

  return (
    <section className="rounded-lg border border-border bg-surface p-4 space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">Skills</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-3 border-b border-border text-xs">
              <th className="pb-2 font-medium">Skill</th>
              <th className="pb-2 font-medium text-right">Uses</th>
              <th className="pb-2 font-medium text-right">Sessions</th>
              <th className="pb-2 font-medium text-right">Avg session $</th>
              <th className="pb-2 font-medium text-right">Avg subagents</th>
              <th className="pb-2 font-medium">Outcomes</th>
              <th className="pb-2 font-medium">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((r) => {
              const skillOutcomes = outcomesBySkill.get(r.skillName) ?? [];
              const totalOutcomeSessions = skillOutcomes.reduce((s, o) => s + o.sessionCount, 0);
              const sub = subagentBySkill.get(r.skillName);
              const sparkline = trendBySkill.get(r.skillName) ?? [];
              const sparkMax = Math.max(...sparkline, 1);

              return (
                <tr key={`${r.skillName}-${r.skillPath ?? ''}`}>
                  <td className="py-2 pr-4">
                    <div className="space-y-1">
                      <span className="font-mono text-xs text-text">{r.skillName}</span>
                      {r.skillPath && (
                        <span className="block text-xs text-text-3 truncate max-w-[160px]">
                          {r.skillPath}
                        </span>
                      )}
                      <div className="h-1 w-full rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent/50"
                          style={{ width: `${(r.useCount / maxCalls) * 100}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-text">
                    {r.useCount.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-text-2">
                    {r.sessionCount.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-text-2">
                    {r.avgSessionCostUsd != null ? fmtCost(r.avgSessionCostUsd) : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-text-2">
                    {sub != null ? sub.avgSubagents.toFixed(1) : '—'}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {skillOutcomes.map((o) => {
                        const cls = STATUS_COLORS[o.status] ?? 'bg-surface-2 text-text-3';
                        return (
                          <span
                            key={o.status}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${cls}`}
                          >
                            {o.status.slice(0, 4)} {pct(o.sessionCount, totalOutcomeSessions)}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="py-2 pl-2">
                    <MiniSparkline values={sparkline} max={sparkMax} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MiniSparkline({ values, max }: { max: number; values: number[] }) {
  if (values.length === 0) {
    return <span className="text-text-3 text-xs">—</span>;
  }
  return (
    <div className="flex items-end gap-px h-6 w-16">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * 24);
        return (
          <div
            key={i}
            className="flex-1 rounded-sm bg-accent/60"
            style={{ height: `${h}px` }}
            title={String(v)}
          />
        );
      })}
    </div>
  );
}

function SkillSequencesSection({ rows }: { rows: SkillSequenceRow[] }) {
  const maxCount = Math.max(...rows.map((r) => r.transitionCount), 1);
  return (
    <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">
          Skill workflows
        </h2>
        <p className="mt-1 text-xs text-text-3">
          Most common consecutive skill pairs within sessions
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={`${r.fromSkill}→${r.toSkill}`} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-mono text-text">
                <span className="text-text-2">{r.fromSkill}</span>
                <span className="text-text-3">→</span>
                <span className="text-accent">{r.toSkill}</span>
              </span>
              <span className="text-text-3">{r.transitionCount}×</span>
            </div>
            <div className="h-1 rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent/40"
                style={{ width: `${(r.transitionCount / maxCount) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
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
