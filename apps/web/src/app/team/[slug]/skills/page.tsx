import Link from 'next/link';
import { TeamSubNav } from '@/app/team/[slug]/layout';
import { DataTable } from '@/components/team-org/DataTable';
import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { SectionCard } from '@/components/team-org/SectionCard';
import { SectionHeader } from '@/components/team-org/SectionHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamDailySkillVolume,
  getTeamSkillAdoptionFunnel,
  getTeamSkillUsage,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function TeamSkillsPage({
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
  const [skills, funnel, trend] = await Promise.all([
    getTeamSkillUsage(visibleIds, since),
    getTeamSkillAdoptionFunnel(visibleIds, since),
    getTeamDailySkillVolume(visibleIds, since),
  ]);

  const totalInvocations = skills.reduce((s, r) => s + r.callCount, 0);
  const uniqueAdopters = funnel.length > 0 ? funnel.reduce((s, r) => s + r.recentUsers, 0) : 0;
  const maxTrend = Math.max(...trend.map((r) => r.invocationCount), 1);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Skills · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <TeamSubNav slug={slug} active="skills" />

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Unique skills" value={skills.length.toString()} />
        <StatCard label="Total invocations" value={totalInvocations.toLocaleString()} />
        <StatCard label="Active adopters" value={uniqueAdopters.toString()} />
      </div>

      {trend.length > 0 && (
        <SectionCard>
          <SectionHeader>Daily invocations</SectionHeader>
          <div className="flex h-16 items-end gap-1">
            {trend.map((r) => (
              <div
                key={r.day.toISOString()}
                className="min-h-[2px] flex-1 rounded-t bg-accent/60"
                style={{ height: `${Math.max((r.invocationCount / maxTrend) * 100, 2)}%` }}
                title={`${r.day.toLocaleDateString()}: ${r.invocationCount}`}
              />
            ))}
          </div>
        </SectionCard>
      )}

      {skills.length > 0 ? (
        <SectionCard>
          <SectionHeader>All skills</SectionHeader>
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
              <tr key={`${r.kind}:${r.name}`} className="border-b border-white/5 hover:bg-white/5">
                <td className="py-2">
                  <Link
                    href={`/team/${slug}/skills/${r.kind}/${encodeURIComponent(r.name)}`}
                    className="font-mono text-accent hover:text-accent/70"
                  >
                    /{r.name}
                  </Link>
                </td>
                <td className="py-2 text-xs capitalize text-white/40">{r.kind}</td>
                <td className="py-2 text-right font-mono text-white/70">
                  {r.callCount.toLocaleString()}
                </td>
                <td className="py-2 text-right font-mono text-white/60">{r.distinctUsers}</td>
                <td className="py-2 text-right font-mono text-white/50">
                  {r.avgSessionCostUsd != null ? `$${r.avgSessionCostUsd.toFixed(3)}` : '—'}
                </td>
              </tr>
            ))}
          </DataTable>
        </SectionCard>
      ) : (
        <EmptyState>No skill activity in this period</EmptyState>
      )}

      {funnel.length > 0 && (
        <SectionCard>
          <SectionHeader>Adoption — new vs returning users</SectionHeader>
          <DataTable
            columns={[
              { label: 'Skill' },
              { align: 'right', label: 'Active users', mono: true },
              { align: 'right', label: 'New', mono: true },
              { align: 'right', label: 'Returning', mono: true },
            ]}
          >
            {funnel.map((r) => (
              <tr key={r.name} className="border-b border-white/5">
                <td className="py-2 font-mono text-white/80">/{r.name}</td>
                <td className="py-2 text-right font-mono text-white/70">{r.recentUsers}</td>
                <td className="py-2 text-right font-mono text-emerald-400">{r.newUsers}</td>
                <td className="py-2 text-right font-mono text-white/50">{r.returningUsers}</td>
              </tr>
            ))}
          </DataTable>
        </SectionCard>
      )}
    </div>
  );
}
