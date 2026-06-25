import {
  getDailyToolVolume,
  getMcpServerUsage,
  getSkillUsage,
  getToolCategoryBreakdown,
  getToolStats,
  type CategoryStatRow,
  type DailyToolVolumeRow,
  type McpServerRow,
  type SkillRow,
  type ToolStatRow,
} from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
import { OrgSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function OrgToolsPage() {
  await requireOrgViewer();

  const since = daysAgo(30);

  const [tools, categories, mcpServers, skills, dailyVolume] = await Promise.all([
    getToolStats(since, 20),
    getToolCategoryBreakdown(since),
    getMcpServerUsage(since),
    getSkillUsage(since),
    getDailyToolVolume(since),
  ]);

  const totalCalls = tools.reduce((s, t) => s + t.callCount, 0);
  const totalDenials = tools.reduce((s, t) => s + t.denyCount, 0);
  const overallDenyRate = totalCalls > 0 ? totalDenials / totalCalls : 0;
  const uniqueTools = tools.length;
  const avgDurations = tools
    .map((t) => t.avgDurationMs)
    .filter((d): d is number => d !== null);
  const overallAvgDuration =
    avgDurations.length > 0
      ? Math.round(avgDurations.reduce((s, d) => s + d, 0) / avgDurations.length)
      : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Org</p>
        <h1 className="text-2xl font-semibold">Tools & Skills</h1>
        <p className="mt-1 text-sm text-white/50">Trailing 30 days · tool usage across the org</p>
      </div>

      <OrgSubNav active="tools" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Tool calls (30d)" value={totalCalls.toLocaleString()} />
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
          <h2 className="text-sm font-semibold text-white/70 mb-4">Daily tool call volume (30d)</h2>
          <DailyVolumeBars volume={dailyVolume} />
        </section>
      )}

      {/* Top tools table */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Top tools (30d)</h2>
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

      {/* Skills & slash commands */}
      {skills.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Skills & slash commands</h2>
          <SkillsTable skills={skills} />
        </section>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-1">
      <p className="text-xs text-white/50">{label}</p>
      <p className={`text-2xl font-semibold ${warn ? 'text-yellow-300' : ''}`}>{value}</p>
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
              <td className="py-2 text-right font-mono text-xs">
                {t.callCount.toLocaleString()}
              </td>
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
  const grouped = new Map<string, { tools: McpServerRow[]; totalCalls: number; users: Set<number> }>();
  for (const row of servers) {
    if (!grouped.has(row.mcpServer)) {
      grouped.set(row.mcpServer, { tools: [], totalCalls: 0, users: new Set() });
    }
    const entry = grouped.get(row.mcpServer)!;
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

function SkillsTable({ skills }: { skills: SkillRow[] }) {
  const maxCalls = Math.max(...skills.map((s) => s.callCount), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-white/40 text-xs text-left">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 font-medium text-right">Invocations</th>
            <th className="pb-2 font-medium text-right">Users</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {skills.map((s) => (
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  file_ops: 'bg-sky-500/20 text-sky-300',
  shell: 'bg-orange-500/20 text-orange-300',
  search: 'bg-violet-500/20 text-violet-300',
  browser: 'bg-green-500/20 text-green-300',
  agent: 'bg-pink-500/20 text-pink-300',
  mcp: 'bg-yellow-500/20 text-yellow-300',
};

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? 'bg-white/10 text-white/50';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${cls}`}>{category}</span>
  );
}
