import Link from 'next/link';
import { DataTable } from '@/components/team-org/DataTable';
import { EmptyState } from '@/components/team-org/EmptyState';
import { PageHeader } from '@/components/team-org/PageHeader';
import { SectionCard } from '@/components/team-org/SectionCard';
import { SectionHeader } from '@/components/team-org/SectionHeader';
import { StatCard } from '@/components/team-org/StatCard';
import {
  getDailySkillVolume,
  getOrgSkillSequences,
  getSkillAdoptionFunnel,
  getSkillUsage,
} from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function OrgSkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);

  const [skills, funnel, trend, sequences] = await Promise.all([
    getSkillUsage(since),
    getSkillAdoptionFunnel(since),
    getDailySkillVolume(since),
    getOrgSkillSequences(since),
  ]);

  const totalInvocations = skills.reduce((s, r) => s + r.callCount, 0);
  const uniqueAdopters = funnel.length > 0 ? Math.max(...funnel.map((r) => r.recentUsers)) : 0;
  const maxTrend = Math.max(...trend.map((r) => r.invocationCount), 1);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days`}
        range={range}
        title="Skills"
      />

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
                className="flex-1 rounded-t bg-accent/60"
                style={{ height: `${(r.invocationCount / maxTrend) * 100}%` }}
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
                    href={`/org/skills/${r.kind}/${encodeURIComponent(r.name)}`}
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

      {sequences.length > 0 && (
        <SectionCard>
          <SectionHeader>Common skill sequences</SectionHeader>
          <DataTable
            columns={[
              { label: 'From' },
              { label: 'To' },
              { align: 'right', label: 'Transitions', mono: true },
            ]}
          >
            {sequences.map((r) => (
              <tr key={`${r.fromSkill}->${r.toSkill}`} className="border-b border-white/5">
                <td className="py-2 font-mono text-white/70">/{r.fromSkill}</td>
                <td className="py-2 font-mono text-white/70">/{r.toSkill}</td>
                <td className="py-2 text-right font-mono text-white/50">
                  {r.transitionCount.toLocaleString()}
                </td>
              </tr>
            ))}
          </DataTable>
          <p className="mt-3 text-xs text-white/30">
            Most frequent skill-to-skill transitions within the same session.
          </p>
        </SectionCard>
      )}
    </div>
  );
}
