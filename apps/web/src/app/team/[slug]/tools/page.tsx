import { DataTable } from '@/components/team-org/DataTable';
import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { SectionCard } from '@/components/team-org/SectionCard';
import { SectionHeader } from '@/components/team-org/SectionHeader';
import { StatCard } from '@/components/team-org/StatCard';
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

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Tool calls" value={totalCalls.toLocaleString()} />
        <StatCard label="Unique tools" value={tools.length.toString()} />
        <StatCard label="Denial rate" value={`${(denyRate * 100).toFixed(1)}%`} />
      </div>

      {categories.length > 0 && (
        <SectionCard>
          <SectionHeader>By category</SectionHeader>
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
        </SectionCard>
      )}

      {tools.length > 0 ? (
        <SectionCard>
          <SectionHeader>Top tools</SectionHeader>
          <DataTable
            columns={[
              { label: 'Tool' },
              { align: 'right', label: 'Calls', mono: true },
              { align: 'right', label: 'Denied', mono: true },
              { align: 'right', label: 'Deny %', mono: true },
              { align: 'right', label: 'Avg ms', mono: true },
              { align: 'right', label: 'Users', mono: true },
            ]}
          >
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
          </DataTable>
        </SectionCard>
      ) : (
        <EmptyState>No tool activity in this period</EmptyState>
      )}

      {skills.length > 0 && (
        <SectionCard>
          <SectionHeader>Skills &amp; slash commands</SectionHeader>
          <DataTable
            columns={[
              { label: 'Name' },
              { label: 'Type' },
              { align: 'right', label: 'Invocations', mono: true },
              { align: 'right', label: 'Users', mono: true },
              { align: 'right', label: 'Avg session $', mono: true },
            ]}
          >
            {skills.map((r) => (
              <tr key={`${r.kind}:${r.name}`} className="border-b border-white/5">
                <td className="py-2 font-mono text-white/80">/{r.name}</td>
                <td className="py-2 text-xs capitalize text-white/40">{r.kind}</td>
                <td className="py-2 text-right font-mono text-white/60">{r.callCount}</td>
                <td className="py-2 text-right font-mono text-white/50">{r.distinctUsers}</td>
                <td className="py-2 text-right font-mono text-white/50">
                  {r.avgSessionCostUsd !== null ? `$${r.avgSessionCostUsd.toFixed(3)}` : '—'}
                </td>
              </tr>
            ))}
          </DataTable>
        </SectionCard>
      )}
    </div>
  );
}
