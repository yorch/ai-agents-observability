import Link from 'next/link';
import { DailyTrendBars } from '@/components/team-org/DailyTrendBars';
import { PageHeader } from '@/components/team-org/PageHeader';
import {
  DeprecationCandidates,
  SubjectQualityPanel,
} from '@/components/team-org/SubjectQualityPanel';
import { Card, EmptyState, SectionHeader, Stat, Table } from '@/components/ui';
import {
  getDailySkillVolume,
  getOrgSkillSequences,
  getSkillAdoptionFunnel,
  getSkillUsage,
  orgVisibleUserIds,
} from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { getDeprecationCandidates, getSkillQuality } from '@/lib/subject-quality-queries';
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

  const visibleIds = await orgVisibleUserIds(since);
  const [skills, funnel, trend, sequences, quality, deprecation] = await Promise.all([
    getSkillUsage(since),
    getSkillAdoptionFunnel(since),
    getDailySkillVolume(since),
    getOrgSkillSequences(since),
    getSkillQuality(visibleIds, since),
    getDeprecationCandidates(visibleIds, since),
  ]);

  const totalInvocations = skills.reduce((s, r) => s + r.callCount, 0);
  const uniqueAdopters = funnel.length > 0 ? Math.max(...funnel.map((r) => r.recentUsers)) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days`}
        range={range}
        title="Skills"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Unique skills" value={skills.length.toString()} />
        <Stat label="Total invocations" value={totalInvocations.toLocaleString()} />
        <Stat label="Active adopters" value={uniqueAdopters.toString()} />
      </div>

      <DailyTrendBars points={trend.map((r) => ({ count: r.invocationCount, day: r.day }))} />

      {skills.length > 0 ? (
        <Card>
          <SectionHeader>All skills</SectionHeader>
          <Table
            columns={[
              { label: 'Name' },
              { label: 'Type' },
              { align: 'right', label: 'Invocations', mono: true },
              { align: 'right', label: 'Users', mono: true },
              { align: 'right', label: 'Avg session $', mono: true },
            ]}
          >
            {skills.map((r) => (
              <tr
                key={`${r.kind}:${r.name}`}
                className="border-b border-border-subtle hover:bg-surface-2"
              >
                <td className="py-2">
                  <Link
                    href={`/org/skills/${r.kind}/${encodeURIComponent(r.name)}`}
                    className="font-mono text-accent hover:opacity-80"
                  >
                    /{r.name}
                  </Link>
                </td>
                <td className="py-2 text-xs capitalize text-text-3">{r.kind}</td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.callCount.toLocaleString()}
                </td>
                <td className="py-2 text-right font-mono text-text-2">{r.distinctUsers}</td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.avgSessionCostUsd != null ? `$${r.avgSessionCostUsd.toFixed(3)}` : '—'}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : (
        <EmptyState>No skill activity in this period</EmptyState>
      )}

      <SubjectQualityPanel
        caption={`How sessions that invoked each skill compare with matched sessions that did not, over the trailing ${range} days.`}
        rows={quality}
        subjectNoun="Skill"
        title="Effectiveness"
      />

      <DeprecationCandidates candidates={deprecation} windowDays={range} />

      {funnel.length > 0 && (
        <Card>
          <SectionHeader>Adoption — new vs returning users</SectionHeader>
          <Table
            columns={[
              { label: 'Skill' },
              { align: 'right', label: 'Active users', mono: true },
              { align: 'right', label: 'New', mono: true },
              { align: 'right', label: 'Returning', mono: true },
            ]}
          >
            {funnel.map((r) => (
              <tr key={r.name} className="border-b border-border-subtle">
                <td className="py-2 font-mono text-text">/{r.name}</td>
                <td className="py-2 text-right font-mono text-text-2">{r.recentUsers}</td>
                <td className="py-2 text-right font-mono text-good">{r.newUsers}</td>
                <td className="py-2 text-right font-mono text-text-2">{r.returningUsers}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {sequences.length > 0 && (
        <Card>
          <SectionHeader>Common skill sequences</SectionHeader>
          <Table
            columns={[
              { label: 'From' },
              { label: 'To' },
              { align: 'right', label: 'Transitions', mono: true },
            ]}
          >
            {sequences.map((r) => (
              <tr key={`${r.fromSkill}->${r.toSkill}`} className="border-b border-border-subtle">
                <td className="py-2 font-mono text-text-2">/{r.fromSkill}</td>
                <td className="py-2 font-mono text-text-2">/{r.toSkill}</td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.transitionCount.toLocaleString()}
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-text-3">
            Most frequent skill-to-skill transitions within the same session.
          </p>
        </Card>
      )}
    </div>
  );
}
