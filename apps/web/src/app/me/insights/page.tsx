import { redirect } from 'next/navigation';
import { ArrowRightIcon } from '@/components/icons';
import { DaysSelector, parseDays } from '@/components/me/DaysSelector';
import { FrictionSourcesChart } from '@/components/me/FrictionSourcesChart';
import { FrictionTrendChart } from '@/components/me/FrictionTrendChart';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { ShapeTrendChart } from '@/components/me/ShapeTrendChart';
import { Card, Cell, EmptyState, Row, Sparkline, Table } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { getUserShapeTrend } from '@/lib/cohort-queries';
import { getUserEffectiveness } from '@/lib/effectiveness-queries';
import { fmtBytes, fmtDurationOrDash, fmtTokens, fmtUsd } from '@/lib/fmt';
import {
  type ContinuitySummaryRow,
  getContinuitySummary,
  getMcpUsage,
  getNotificationKinds,
  getSessionSummary,
  getSkillOutcomes,
  getSkillSequences,
  getSkillSubagents,
  getSkillTrend,
  getSkillUsage,
  getSlashCommands,
  getSubagentUsage,
  getToolPerf,
  getUserCacheSummary,
  getUserModelRouting,
  type McpUsageRow,
  type NotificationKindRow,
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
import { buildRecommendations, type Recommendation } from '@/lib/recommendations';

export const dynamic = 'force-dynamic';

function pct(num: number, den: number): string {
  if (den === 0) {
    return '—';
  }
  return `${((num / den) * 100).toFixed(1)}%`;
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
    continuity,
    notificationKinds,
    shapeTrend,
    modelRouting,
    cacheSummary,
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
    getContinuitySummary(user.id, since),
    getNotificationKinds(user.id, since),
    getUserShapeTrend(user.id, since),
    getUserModelRouting(user.id, since),
    getUserCacheSummary(user.id, since),
  ]);

  const recommendations = buildRecommendations({
    mcp,
    modelRouting,
    scoredSessionCount: effectiveness.scoredSessionCount,
    sources: effectiveness.sources,
    toolPerf,
    cacheSummary,
  });

  const hasSessionData = summary.sessionCount > 0;
  const hasEventData =
    mcp.length > 0 ||
    modelRouting.length > 0 ||
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
        <DaysSelector basePath="/me/insights" current={days} />
      </div>

      {!hasSessionData && !hasEventData ? (
        <EmptyState>
          No data for the selected window. Run some sessions to see insights here.
        </EmptyState>
      ) : (
        <>
          {hasSessionData && <SessionSummaryCards summary={summary} />}

          {hasSessionData && (
            <>
              <div className="grid gap-6 md:grid-cols-2">
                <FrictionTrendChart
                  points={effectiveness.trend}
                  scoredSessionCount={effectiveness.scoredSessionCount}
                />
                <ShapeDistributionChart histogram={effectiveness.shapeHistogram} />
              </div>
              <ShapeTrendChart buckets={shapeTrend} />
              <div className="grid gap-6 md:grid-cols-2">
                <FrictionSourcesChart
                  scoredSessionCount={effectiveness.scoredSessionCount}
                  sources={effectiveness.sources}
                />
                {recommendations.length > 0 && <RecommendationsSection recs={recommendations} />}
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <ContinuitySection continuity={continuity} />
                <NotificationKindsSection rows={notificationKinds} />
              </div>
            </>
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

function RecommendationsSection({ recs }: { recs: Recommendation[] }) {
  return (
    <Card contentClassName="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
        Recommendations
      </h2>
      <ul className="space-y-2.5">
        {recs.map((r) => (
          <li key={r.id} className="flex gap-2.5">
            <span
              className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                r.severity === 'warn' ? 'bg-warn' : 'bg-series-1'
              }`}
            />
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-text">{r.title}</p>
              <p className="text-xs text-text-2">{r.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SessionSummaryCards({ summary: s }: { summary: SessionSummaryRow }) {
  const cards = [
    { label: 'Sessions', value: s.sessionCount.toLocaleString() },
    { label: 'Total cost', value: fmtUsd(s.totalCostUsd) },
    { label: 'Avg cost / session', value: s.sessionCount > 0 ? fmtUsd(s.avgCostUsd) : '—' },
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

// Kinds are categorical. `other` is the genuine catch-all and stays neutral;
// everything named gets its own series slot.
const NOTIFICATION_KIND_META: Record<string, { color: string; label: string }> = {
  auth: { color: 'bg-series-6', label: 'Auth' },
  elicitation: { color: 'bg-series-4', label: 'Elicitation' },
  idle: { color: 'bg-series-1', label: 'Idle (waiting on you)' },
  other: { color: 'bg-surface-3', label: 'Other' },
  permission: { color: 'bg-series-2', label: 'Permission' },
};

function ContinuitySection({ continuity: c }: { continuity: ContinuitySummaryRow }) {
  const resumeShare = c.sessionCount > 0 ? c.resumedSessions / c.sessionCount : 0;
  const avgCompactions = c.sessionCount > 0 ? c.totalCompactions / c.sessionCount : 0;
  const cards = [
    {
      label: 'Resumed sessions',
      sub: `${pct(c.resumedSessions, c.sessionCount)} of sessions`,
      value: c.resumedSessions.toLocaleString(),
    },
    {
      label: 'Sessions hitting a reset',
      sub: 'compaction or /clear',
      value: c.sessionsWithReset.toLocaleString(),
    },
    {
      label: 'Compactions',
      sub: `${avgCompactions.toFixed(1)} avg / session`,
      value: c.totalCompactions.toLocaleString(),
    },
    { label: 'Clears', sub: 'context wiped', value: c.totalClears.toLocaleString() },
  ];
  return (
    <SectionShell title="Context &amp; continuity" empty={c.sessionCount === 0}>
      <p className="-mt-1 text-xs text-text-3">
        Frequent compactions or clears flag sessions fighting the context window.
        {resumeShare > 0.5 && ' Most of your work resumes an earlier session.'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-border bg-surface-2/40 px-3 py-2"
          >
            <p className="text-xs text-text-3">{card.label}</p>
            <p className="text-lg font-semibold tabular-nums text-text">{card.value}</p>
            <p className="text-[11px] text-text-3">{card.sub}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function NotificationKindsSection({ rows }: { rows: NotificationKindRow[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <SectionShell title="Attention requests" empty={rows.length === 0}>
      <p className="-mt-1 text-xs text-text-3">
        How often the agent stopped to get your attention, by kind.
      </p>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const meta = NOTIFICATION_KIND_META[r.kind] ?? {
            color: 'bg-surface-3',
            label: r.kind,
          };
          return (
            <div key={r.kind} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-text-2">
                  <span className={`h-2 w-2 rounded-full ${meta.color}`} />
                  {meta.label}
                </span>
                <span className="text-text-3">
                  {r.count}× · {pct(r.count, total)}
                </span>
              </div>
              <div className="h-1 rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${meta.color}`}
                  style={{ width: `${total > 0 ? (r.count / total) * 100 : 0}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </SectionShell>
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
    <Card contentClassName="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">{title}</h2>
      {empty ? <p className="text-sm text-text-3">No data in this window.</p> : children}
    </Card>
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
                      <span className="ml-2">{fmtDurationOrDash(r.avgDurationMs)}</span>
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
  ABANDONED: 'bg-warn-soft text-warn',
  COMPLETED: 'bg-good-soft text-good',
  ERROR: 'bg-crit-soft text-crit',
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
    <Card contentClassName="space-y-4">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">Skills</h2>
      <Table
        columns={[
          { label: 'Skill' },
          { align: 'right', label: 'Uses' },
          { align: 'right', label: 'Sessions' },
          { align: 'right', label: 'Avg session $' },
          { align: 'right', label: 'Avg subagents' },
          { label: 'Outcomes' },
          { label: 'Trend' },
        ]}
      >
        {rows.map((r) => {
          const skillOutcomes = outcomesBySkill.get(r.skillName) ?? [];
          const totalOutcomeSessions = skillOutcomes.reduce((s, o) => s + o.sessionCount, 0);
          const sub = subagentBySkill.get(r.skillName);
          const sparkline = trendBySkill.get(r.skillName) ?? [];
          const sparkMax = Math.max(...sparkline, 1);

          return (
            <Row key={`${r.skillName}-${r.skillPath ?? ''}`}>
              <Cell>
                <div className="space-y-1">
                  <span className="font-mono text-xs text-text">{r.skillName}</span>
                  {r.skillPath && (
                    <span className="block text-xs text-text-3 truncate max-w-[160px]">
                      {r.skillPath}
                    </span>
                  )}
                  <div className="h-1 w-full rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent-muted"
                      style={{ width: `${(r.useCount / maxCalls) * 100}%` }}
                    />
                  </div>
                </div>
              </Cell>
              <Cell num className="text-xs text-text">
                {r.useCount.toLocaleString()}
              </Cell>
              <Cell num className="text-xs text-text-2">
                {r.sessionCount.toLocaleString()}
              </Cell>
              <Cell num className="text-xs text-text-2">
                {r.avgSessionCostUsd != null ? fmtUsd(r.avgSessionCostUsd) : '—'}
              </Cell>
              <Cell num className="text-xs text-text-2">
                {sub != null ? sub.avgSubagents.toFixed(1) : '—'}
              </Cell>
              <Cell>
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
              </Cell>
              <Cell>
                <Sparkline points={sparkline} domain={[0, sparkMax]} tone="accent" />
              </Cell>
            </Row>
          );
        })}
      </Table>
    </Card>
  );
}

function SkillSequencesSection({ rows }: { rows: SkillSequenceRow[] }) {
  const maxCount = Math.max(...rows.map((r) => r.transitionCount), 1);
  return (
    <Card contentClassName="space-y-3">
      <div>
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
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
                <ArrowRightIcon size={11} className="text-text-3" />
                <span className="text-accent">{r.toSkill}</span>
              </span>
              <span className="text-text-3">{r.transitionCount}×</span>
            </div>
            <div className="h-1 rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent-muted"
                style={{ width: `${(r.transitionCount / maxCount) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
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
                  className="h-full rounded-full bg-accent-muted"
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
    <Card contentClassName="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
        Tool performance
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-text-3">No PostToolUse events in this window.</p>
      ) : (
        <Table
          columns={[
            { label: 'Tool' },
            { label: 'Category' },
            { align: 'right', label: 'Calls' },
            { align: 'right', label: 'Errors' },
            { align: 'right', label: 'Denied' },
            { align: 'right', label: 'Avg' },
            { align: 'right', label: 'p95' },
            { align: 'right', label: 'Avg in' },
            { align: 'right', label: 'Avg out' },
          ]}
        >
          {rows.map((r) => (
            <Row key={r.toolName}>
              <Cell className="text-xs text-text">{r.toolName}</Cell>
              <Cell className="text-xs text-text-3">{r.toolCategory ?? '—'}</Cell>
              <Cell num className="text-text-2">
                {r.callCount}
              </Cell>
              <Cell
                num
                className={`py-2 text-right text-xs ${
                  r.errorCount > 0 ? 'text-crit' : 'text-text-3'
                }`}
              >
                {r.errorCount > 0 ? `${r.errorCount} (${pct(r.errorCount, r.callCount)})` : '—'}
              </Cell>
              <Cell
                num
                className={`py-2 text-right text-xs ${
                  r.deniedCount > 0 ? 'text-warn' : 'text-text-3'
                }`}
              >
                {r.deniedCount > 0 ? r.deniedCount : '—'}
              </Cell>
              <Cell num className="text-xs text-text-2">
                {fmtDurationOrDash(r.avgDurationMs)}
              </Cell>
              <Cell num className="text-xs text-text-3">
                {fmtDurationOrDash(r.p95DurationMs)}
              </Cell>
              <Cell num className="text-xs text-text-3">
                {fmtBytes(r.avgInputBytes)}
              </Cell>
              <Cell num className="text-xs text-text-3">
                {fmtBytes(r.avgOutputBytes)}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  );
}
