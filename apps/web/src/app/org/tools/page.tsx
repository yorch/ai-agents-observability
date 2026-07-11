import { ArrowRightIcon } from '@/components/icons';
import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import {
  type CategoryStatRow,
  type DailyToolVolumeRow,
  getDailyToolVolume,
  getMcpServerUsage,
  getOrgSkillSequences,
  getSkillAdoptionFunnel,
  getSkillRoi,
  getSkillUsage,
  getTeamSkillMatrix,
  getToolCategoryBreakdown,
  getToolStats,
  type McpServerRow,
  type OrgSkillSequenceRow,
  type SkillAdoptionRow,
  type SkillRoiRow,
  type SkillRow,
  type TeamSkillRow,
  type ToolStatRow,
} from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

export default async function OrgToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);

  const [
    tools,
    categories,
    mcpServers,
    skills,
    dailyVolume,
    teamSkillMatrix,
    skillAdoption,
    skillSequences,
    skillRoi,
  ] = await Promise.all([
    getToolStats(since, 20),
    getToolCategoryBreakdown(since),
    getMcpServerUsage(since),
    getSkillUsage(since),
    getDailyToolVolume(since),
    getTeamSkillMatrix(since),
    getSkillAdoptionFunnel(since),
    getOrgSkillSequences(since),
    getSkillRoi(since),
  ]);

  const totalCalls = tools.reduce((s, t) => s + t.callCount, 0);
  const totalDenials = tools.reduce((s, t) => s + t.denyCount, 0);
  const overallDenyRate = totalCalls > 0 ? totalDenials / totalCalls : 0;
  const uniqueTools = tools.length;
  const avgDurations = tools.map((t) => t.avgDurationMs).filter((d): d is number => d !== null);
  const overallAvgDuration =
    avgDurations.length > 0
      ? Math.round(avgDurations.reduce((s, d) => s + d, 0) / avgDurations.length)
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days · tool usage across the org`}
        range={range}
        title="Tools & Skills"
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={`Tool calls (${range}d)`} value={totalCalls.toLocaleString()} />
        <StatCard label="Unique tools" value={uniqueTools.toString()} />
        <StatCard
          label="Denial rate"
          value={totalCalls > 0 ? `${(overallDenyRate * 100).toFixed(1)}%` : '—'}
          warn={overallDenyRate > 0.05}
        />
        <StatCard
          label="Avg duration"
          value={overallAvgDuration !== null ? `${overallAvgDuration.toLocaleString()} ms` : '—'}
        />
      </div>

      {/* Daily volume trend */}
      {dailyVolume.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-semibold text-white/70 mb-4">
            Daily tool call volume ({range}d)
          </h2>
          <DailyVolumeBars volume={dailyVolume} />
        </section>
      )}

      {/* Top tools table */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Top tools ({range}d)</h2>
        {tools.length === 0 ? (
          <p className="text-sm text-white/40">No tool data available.</p>
        ) : (
          <ToolsTable tools={tools} />
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Category breakdown */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">By category</h2>
          {categories.length === 0 ? (
            <p className="text-sm text-white/40">No data available.</p>
          ) : (
            <CategoryBreakdown categories={categories} />
          )}
        </section>

        {/* MCP servers */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">MCP servers</h2>
          {mcpServers.length === 0 ? (
            <p className="text-sm text-white/40">No MCP usage in this period.</p>
          ) : (
            <McpTable servers={mcpServers} />
          )}
        </section>
      </div>

      {/* Skills & slash commands — always rendered so the section is visible even before data */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Skills & slash commands</h2>
        {skills.length === 0 ? (
          <p className="text-sm text-white/40">
            No skill or slash command invocations in the last {range} days. Skills are captured when
            the <span className="font-mono text-white/60">Skill</span> tool fires (e.g.{' '}
            <span className="font-mono text-white/60">/code-review</span>,{' '}
            <span className="font-mono text-white/60">/commit</span>).
          </p>
        ) : (
          <SkillsTable skills={skills} adoption={skillAdoption} />
        )}
      </section>

      {/* Team skill matrix */}
      {teamSkillMatrix.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-white/70">Skill adoption by team</h2>
            <p className="text-xs text-white/40 mt-0.5">Which skills each team uses most</p>
          </div>
          <TeamSkillMatrix rows={teamSkillMatrix} />
        </section>
      )}

      {/* Skill workflows */}
      {skillSequences.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-white/70">Skill workflows</h2>
            <p className="text-xs text-white/40 mt-0.5">
              Most common consecutive skill pairs within sessions
            </p>
          </div>
          <SkillSequences rows={skillSequences} />
        </section>
      )}

      {/* Skill ROI */}
      {skillRoi.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-white/70">Skill × PR CI status</h2>
            <p className="text-xs text-white/40 mt-0.5">
              Sessions using each skill, broken down by PR CI outcome
            </p>
          </div>
          <SkillRoiTable rows={skillRoi} />
        </section>
      )}
    </div>
  );
}

function DailyVolumeBars({ volume }: { volume: DailyToolVolumeRow[] }) {
  const max = Math.max(...volume.map((v) => v.callCount), 1);
  return (
    <div className="flex items-end gap-0.5 h-28">
      {volume.map((v) => {
        const height = Math.max(4, (v.callCount / max) * 112);
        const denyHeight = v.callCount > 0 ? (v.denyCount / v.callCount) * height : 0;
        const label = new Date(v.day).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
        });
        return (
          <div key={v.day.toISOString()} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[9px] text-white/30">{v.callCount}</span>
            <div
              className="w-full rounded-t bg-brand-500/70 relative min-h-1"
              style={{ height: `${height}px` }}
              title={`${label}: ${v.callCount} calls, ${v.denyCount} denied`}
            >
              {denyHeight > 0 && (
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-t bg-yellow-500/60"
                  style={{ height: `${denyHeight}px` }}
                />
              )}
            </div>
            <span className="text-[8px] text-white/20">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function ToolsTable({ tools }: { tools: ToolStatRow[] }) {
  const maxCalls = Math.max(...tools.map((t) => t.callCount), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-white/40 text-left text-xs">
            <th className="pb-2 font-medium w-1/3">Tool</th>
            <th className="pb-2 font-medium">Category</th>
            <th className="pb-2 font-medium text-right">Calls</th>
            <th className="pb-2 font-medium text-right">Denied</th>
            <th className="pb-2 font-medium text-right">Deny %</th>
            <th className="pb-2 font-medium text-right">Avg ms</th>
            <th className="pb-2 font-medium text-right">Users</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {tools.map((t) => (
            <tr key={t.toolName}>
              <td className="py-2 pr-3">
                <div className="space-y-1">
                  <span className="font-mono text-xs text-white/90 truncate block max-w-48">
                    {t.toolName}
                  </span>
                  <div className="h-1 w-full rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full bg-brand-500/60"
                      style={{ width: `${(t.callCount / maxCalls) * 100}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className="py-2">
                <CategoryBadge category={t.category} />
              </td>
              <td className="py-2 text-right font-mono text-xs">{t.callCount.toLocaleString()}</td>
              <td className="py-2 text-right font-mono text-xs text-white/60">
                {t.denyCount > 0 ? t.denyCount.toLocaleString() : '—'}
              </td>
              <td className="py-2 text-right font-mono text-xs">
                {t.denyCount > 0 ? (
                  <span className={t.denyRate > 0.1 ? 'text-yellow-300' : 'text-white/60'}>
                    {(t.denyRate * 100).toFixed(1)}%
                  </span>
                ) : (
                  <span className="text-white/30">—</span>
                )}
              </td>
              <td className="py-2 text-right font-mono text-xs text-white/60">
                {t.avgDurationMs !== null ? t.avgDurationMs.toLocaleString() : '—'}
              </td>
              <td className="py-2 text-right text-white/60 text-xs">{t.distinctUsers}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryBreakdown({ categories }: { categories: CategoryStatRow[] }) {
  const totalCalls = categories.reduce((s, c) => s + c.callCount, 0);
  return (
    <div className="space-y-2">
      {categories.map((c) => {
        const pct = totalCalls > 0 ? (c.callCount / totalCalls) * 100 : 0;
        return (
          <div key={c.category} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="font-mono text-white/80">{c.category}</span>
              <span className="text-white/50">
                {c.callCount.toLocaleString()}
                {c.denyCount > 0 && (
                  <span className="text-yellow-400/70 ml-1">({c.denyCount} denied)</span>
                )}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${pct.toFixed(1)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function McpTable({ servers }: { servers: McpServerRow[] }) {
  const grouped = new Map<
    string,
    { tools: McpServerRow[]; totalCalls: number; users: Set<number> }
  >();
  for (const row of servers) {
    if (!grouped.has(row.mcpServer)) {
      grouped.set(row.mcpServer, { tools: [], totalCalls: 0, users: new Set() });
    }
    const entry = grouped.get(row.mcpServer);
    if (!entry) {
      continue;
    }
    entry.tools.push(row);
    entry.totalCalls += row.callCount;
  }

  return (
    <div className="space-y-4">
      {[...grouped.entries()].map(([server, data]) => (
        <div key={server} className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="font-mono text-xs font-semibold text-white/80">{server}</span>
            <span className="text-xs text-white/40">{data.totalCalls.toLocaleString()} calls</span>
          </div>
          <div className="pl-3 space-y-1 border-l border-white/10">
            {data.tools.map((t) => (
              <div
                key={`${t.mcpServer}/${t.mcpTool ?? '__server__'}`}
                className="flex justify-between text-xs"
              >
                <span className="font-mono text-white/60">{t.mcpTool ?? '(server-level)'}</span>
                <span className="text-white/40">
                  {t.callCount.toLocaleString()} · {t.distinctUsers} user
                  {t.distinctUsers !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillsTable({ adoption, skills }: { adoption: SkillAdoptionRow[]; skills: SkillRow[] }) {
  const maxCalls = Math.max(...skills.map((s) => s.callCount), 1);
  const adoptionByName = new Map(adoption.map((a) => [a.name, a]));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-white/40 text-xs text-left">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 font-medium text-right">Invocations</th>
            <th className="pb-2 font-medium text-right">Users</th>
            <th className="pb-2 font-medium text-right">Avg session $</th>
            <th className="pb-2 font-medium text-right">New / Return</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {skills.map((s) => {
            const adp = adoptionByName.get(s.name);
            return (
              <tr key={`${s.kind}:${s.name}`}>
                <td className="py-2 pr-3">
                  <div className="space-y-1">
                    <span className="font-mono text-xs text-white/90">{s.name}</span>
                    <div className="h-1 w-full rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-brand-500/60"
                        style={{ width: `${(s.callCount / maxCalls) * 100}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="py-2">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                      s.kind === 'skill'
                        ? 'bg-brand-500/20 text-brand-400'
                        : 'bg-white/10 text-white/60'
                    }`}
                  >
                    {s.kind === 'skill' ? 'skill' : '/cmd'}
                  </span>
                </td>
                <td className="py-2 text-right font-mono text-xs">
                  {s.callCount.toLocaleString()}
                </td>
                <td className="py-2 text-right text-xs text-white/60">{s.distinctUsers}</td>
                <td className="py-2 text-right font-mono text-xs text-white/60">
                  {s.avgSessionCostUsd != null ? `$${s.avgSessionCostUsd.toFixed(2)}` : '—'}
                </td>
                <td className="py-2 text-right text-xs text-white/60">
                  {adp != null ? (
                    <span>
                      <span className="text-emerald-400">{adp.newUsers}</span>
                      {' / '}
                      <span>{adp.returningUsers}</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TeamSkillMatrix({ rows }: { rows: TeamSkillRow[] }) {
  // Group skills by name, collect teams
  const bySkill = new Map<string, { kind: string; teams: Map<string, number> }>();
  for (const r of rows) {
    if (!bySkill.has(r.name)) {
      bySkill.set(r.name, { kind: r.kind, teams: new Map() });
    }
    bySkill.get(r.name)?.teams.set(r.teamName, r.callCount);
  }

  const allTeams = Array.from(new Set(rows.map((r) => r.teamName))).sort();

  if (allTeams.length === 0) {
    return <p className="text-sm text-white/40">No team membership data available.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-white/40 text-left">
            <th className="pb-2 font-medium pr-4">Skill</th>
            {allTeams.map((t) => (
              <th key={t} className="pb-2 font-medium text-right px-2 truncate max-w-20">
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {[...bySkill.entries()].map(([name, { kind, teams }]) => (
            <tr key={name}>
              <td className="py-2 pr-4">
                <span className="font-mono text-white/80">{name}</span>
                <span
                  className={`ml-2 text-[10px] px-1 py-0.5 rounded ${
                    kind === 'skill'
                      ? 'bg-brand-500/20 text-brand-400'
                      : 'bg-white/10 text-white/50'
                  }`}
                >
                  {kind === 'skill' ? 's' : '/'}
                </span>
              </td>
              {allTeams.map((t) => {
                const count = teams.get(t);
                return (
                  <td key={t} className="py-2 text-right px-2 font-mono">
                    {count != null ? (
                      <span className="text-white/70">{count.toLocaleString()}</span>
                    ) : (
                      <span className="text-white/20">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkillSequences({ rows }: { rows: OrgSkillSequenceRow[] }) {
  const maxCount = Math.max(...rows.map((r) => r.transitionCount), 1);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={`${r.fromSkill}→${r.toSkill}`} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-mono">
              <span className="text-white/70">{r.fromSkill}</span>
              <ArrowRightIcon size={11} className="text-white/30" />
              <span className="text-brand-400">{r.toSkill}</span>
            </span>
            <span className="text-white/40">{r.transitionCount}×</span>
          </div>
          <div className="h-1 rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-brand-500/50"
              style={{ width: `${(r.transitionCount / maxCount) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const CI_COLORS: Record<string, string> = {
  failure: 'text-red-400',
  pending: 'text-yellow-400',
  success: 'text-emerald-400',
};

function SkillRoiTable({ rows }: { rows: SkillRoiRow[] }) {
  // Group by skill name, then list CI statuses
  const bySkill = new Map<string, SkillRoiRow[]>();
  for (const r of rows) {
    if (!bySkill.has(r.skillName)) {
      bySkill.set(r.skillName, []);
    }
    bySkill.get(r.skillName)?.push(r);
  }

  return (
    <div className="space-y-4">
      {[...bySkill.entries()].map(([skill, ciRows]) => {
        const total = ciRows.reduce((s, r) => s + r.sessionCount, 0);
        const successCount = ciRows.find((r) => r.ciStatus === 'success')?.sessionCount ?? 0;
        const passRate = total > 0 ? (successCount / total) * 100 : 0;
        return (
          <div key={skill} className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-white/80">{skill}</span>
              <span className="text-emerald-400 font-mono">{passRate.toFixed(0)}% pass</span>
            </div>
            <div className="flex gap-1">
              {ciRows.map((r) => {
                const w = total > 0 ? (r.sessionCount / total) * 100 : 0;
                const cls = CI_COLORS[r.ciStatus] ?? 'text-white/40';
                return (
                  <div
                    key={r.ciStatus}
                    className="text-[10px] font-mono"
                    style={{ width: `${w}%` }}
                  >
                    <div
                      className={`h-2 rounded-sm ${
                        r.ciStatus === 'success'
                          ? 'bg-emerald-500/40'
                          : r.ciStatus === 'failure'
                            ? 'bg-red-500/40'
                            : 'bg-yellow-500/40'
                      }`}
                      title={`${r.ciStatus}: ${r.sessionCount} sessions`}
                    />
                    <span className={`${cls} block text-center`}>{r.ciStatus.slice(0, 4)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  browser: 'bg-green-500/20 text-green-300',
  file_ops: 'bg-sky-500/20 text-sky-300',
  mcp: 'bg-yellow-500/20 text-yellow-300',
  search: 'bg-violet-500/20 text-violet-300',
  shell: 'bg-orange-500/20 text-orange-300',
};

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? 'bg-white/10 text-white/50';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${cls}`}>{category}</span>;
}
