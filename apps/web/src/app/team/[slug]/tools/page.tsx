import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamSkillUsage,
  getTeamToolCategoryBreakdown,
  getTeamToolStats,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { TeamSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function TeamToolsPage({
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
  const [tools, categories, skills] = await Promise.all([
    getTeamToolStats(visibleIds, since),
    getTeamToolCategoryBreakdown(visibleIds, since),
    getTeamSkillUsage(visibleIds, since),
  ]);

  const totalCalls = tools.reduce((s, r) => s + r.callCount, 0);
  const totalDenied = tools.reduce((s, r) => s + r.denyCount, 0);
  const denyRate = totalCalls > 0 ? totalDenied / totalCalls : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Tool & skill usage · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <TeamSubNav slug={slug} active="tools" />

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Tool calls', value: totalCalls.toLocaleString() },
          { label: 'Unique tools', value: tools.length.toString() },
          { label: 'Denial rate', value: `${(denyRate * 100).toFixed(1)}%` },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-xs text-white/40 uppercase tracking-wider">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold font-mono">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Tool category breakdown */}
      {categories.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">By category</h3>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <div
                key={c.category}
                className="flex items-center gap-2 rounded bg-white/10 px-3 py-1.5 text-sm"
              >
                <span className="capitalize text-white/80">{c.category}</span>
                <span className="font-mono text-xs text-white/50">
                  {c.callCount.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top tools table */}
      {tools.length > 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">Top tools</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-xs border-b border-white/10">
                <th className="text-left pb-2">Tool</th>
                <th className="text-right pb-2 font-mono">Calls</th>
                <th className="text-right pb-2 font-mono">Denied</th>
                <th className="text-right pb-2 font-mono">Deny %</th>
                <th className="text-right pb-2 font-mono">Avg ms</th>
                <th className="text-right pb-2 font-mono">Users</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((r) => (
                <tr key={r.toolName} className="border-b border-white/5">
                  <td className="py-2 font-mono text-white/80">{r.toolName}</td>
                  <td className="py-2 text-right font-mono text-white/60">
                    {r.callCount.toLocaleString()}
                  </td>
                  <td
                    className={`py-2 text-right font-mono ${r.denyCount > 0 ? 'text-amber-400' : 'text-white/30'}`}
                  >
                    {r.denyCount > 0 ? r.denyCount : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-white/50">
                    {r.denyRate > 0 ? `${(r.denyRate * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-white/50">
                    {r.avgDurationMs !== null ? r.avgDurationMs : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-white/50">{r.distinctUsers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>No tool activity in this period</EmptyState>
      )}

      {/* Skills & slash commands */}
      {skills.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">
            Skills & slash commands
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-xs border-b border-white/10">
                <th className="text-left pb-2">Name</th>
                <th className="text-left pb-2">Type</th>
                <th className="text-right pb-2 font-mono">Invocations</th>
                <th className="text-right pb-2 font-mono">Users</th>
                <th className="text-right pb-2 font-mono">Avg session $</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((r) => (
                <tr key={`${r.kind}:${r.name}`} className="border-b border-white/5">
                  <td className="py-2 font-mono text-white/80">/{r.name}</td>
                  <td className="py-2 text-xs text-white/40 capitalize">{r.kind}</td>
                  <td className="py-2 text-right font-mono text-white/60">{r.callCount}</td>
                  <td className="py-2 text-right font-mono text-white/50">{r.distinctUsers}</td>
                  <td className="py-2 text-right font-mono text-white/50">
                    {r.avgSessionCostUsd !== null ? `$${r.avgSessionCostUsd.toFixed(3)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
