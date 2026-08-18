import Link from 'next/link';
import { DailyTrendBars } from '@/components/team-org/DailyTrendBars';
import { PageHeader } from '@/components/team-org/PageHeader';
import {
  DeprecationCandidates,
  SubjectQualityPanel,
} from '@/components/team-org/SubjectQualityPanel';
import { Card, EmptyState, SectionHeader, Stat, Table } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import {
  getDeprecationCandidates,
  getSkillQuality,
  getSubjectScoreSeries,
} from '@/lib/subject-quality-queries';
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
  const [skills, funnel, trend, quality, deprecation] = await Promise.all([
    getTeamSkillUsage(visibleIds, since),
    getTeamSkillAdoptionFunnel(visibleIds, since),
    getTeamDailySkillVolume(visibleIds, since),
    // The same component as /org/skills, scoped to the team's visible members —
    // the panel inherits its volume gates, so a small team simply reads
    // "not yet measurable" rather than getting a noisier version of the claim.
    getSkillQuality(visibleIds, since),
    getDeprecationCandidates(visibleIds, since),
  ]);

  const totalInvocations = skills.reduce((s, r) => s + r.callCount, 0);
  const uniqueAdopters = funnel.length > 0 ? funnel.reduce((s, r) => s + r.recentUsers, 0) : 0;

  // The stored series behind the error-rate column (P13-013). Keyed the same
  // way `scores.subject_id` is, so the panel needs no id-shaping of its own.
  const qualitySeries = await getSubjectScoreSeries('SKILL', quality);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Skills · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Unique skills" value={skills.length.toString()} />
        <Stat label="Total invocations" value={totalInvocations.toLocaleString()} />
        <Stat label="Active adopters" value={uniqueAdopters.toString()} />
      </div>

      <DailyTrendBars points={trend.map((r) => ({ count: r.invocationCount, day: r.day }))} />

      <SubjectQualityPanel
        caption={`How sessions that invoked each skill compare with matched sessions that did not, over the trailing ${range} days.`}
        rows={quality}
        series={qualitySeries}
        subjectNoun="Skill"
        title="Effectiveness"
      />

      <DeprecationCandidates candidates={deprecation} windowDays={range} />

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
                    href={`/team/${slug}/skills/${r.kind}/${encodeURIComponent(r.name)}`}
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
    </div>
  );
}
