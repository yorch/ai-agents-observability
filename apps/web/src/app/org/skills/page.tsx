import Link from 'next/link';
import { CostAttributionNote } from '@/components/CostAttributionNote';
import { DailyTrendBars } from '@/components/team-org/DailyTrendBars';
import { PageHeader } from '@/components/team-org/PageHeader';
import {
  DeprecationCandidates,
  SubjectQualityPanel,
} from '@/components/team-org/SubjectQualityPanel';
import { Card, EmptyState, SectionHeader, Stat, Table } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { getAttributionCoverage } from '@/lib/attribution-coverage';
import { fmtUsdOrDash } from '@/lib/fmt';
import {
  getDailySkillVolume,
  getOrgSkillSequences,
  getSkillAdoptionFunnel,
  getSkillUsage,
  orgVisibleUserIds,
} from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import {
  getDeprecationCandidates,
  getSkillQuality,
  getSubjectScoreSeries,
} from '@/lib/subject-quality-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function OrgSkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { dict } = await getTranslations();
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);

  const visibleIds = await orgVisibleUserIds(since);
  const [skills, funnel, trend, sequences, quality, deprecation, coverage] = await Promise.all([
    getSkillUsage(since),
    getSkillAdoptionFunnel(since),
    getDailySkillVolume(since),
    getOrgSkillSequences(since),
    getSkillQuality(visibleIds, since),
    getDeprecationCandidates(visibleIds, since),
    getAttributionCoverage(visibleIds, since),
  ]);

  const totalInvocations = skills.reduce((s, r) => s + r.callCount, 0);
  const uniqueAdopters = funnel.length > 0 ? Math.max(...funnel.map((r) => r.recentUsers)) : 0;

  // The stored series behind the error-rate column (P13-013). Keyed the same
  // way `scores.subject_id` is, so the panel needs no id-shaping of its own.
  const qualitySeries = await getSubjectScoreSeries('SKILL', quality);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Trailing ${range} days`}
        range={range}
        title={dict.org.skills.title}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={dict.org.skills.uniqueSkills} value={skills.length.toString()} />
        <Stat label={dict.org.skills.totalInvocations} value={totalInvocations.toLocaleString()} />
        <Stat label={dict.org.skills.activeAdopters} value={uniqueAdopters.toString()} />
      </div>

      <DailyTrendBars points={trend.map((r) => ({ count: r.invocationCount, day: r.day }))} />

      {skills.length > 0 ? (
        <Card>
          <SectionHeader>{dict.org.skills.allSkills}</SectionHeader>
          <Table
            columns={[
              { label: 'Name' },
              { label: 'Type' },
              { align: 'right', label: 'Invocations', mono: true },
              { align: 'right', label: 'Users', mono: true },
              // The pre-P14-004 proxy, kept beside the real numbers rather than
              // replaced — retiring it is someone's decision to take.
              { align: 'right', label: 'Avg session $', mono: true },
              // P14-004: two lenses on the same dollars, never a total.
              { align: 'right', label: 'Turn share', mono: true },
              { align: 'right', label: 'Downstream', mono: true },
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
                <td className="py-2 text-right font-mono text-text-2">
                  {fmtUsdOrDash(r.attributedCostUsd)}
                </td>
                <td className="py-2 text-right font-mono text-text-2">
                  {fmtUsdOrDash(r.downstreamCostUsd)}
                </td>
              </tr>
            ))}
          </Table>
          <CostAttributionNote className="mt-3" coverage={coverage} />
        </Card>
      ) : (
        <EmptyState>{dict.org.skills.empty}</EmptyState>
      )}

      <SubjectQualityPanel
        caption={`How sessions that invoked each skill compare with matched sessions that did not, over the trailing ${range} days.`}
        rows={quality}
        series={qualitySeries}
        subjectNoun="Skill"
        title={dict.org.skills.effectiveness}
      />

      <DeprecationCandidates candidates={deprecation} windowDays={range} />

      {funnel.length > 0 && (
        <Card>
          <SectionHeader>{dict.org.skills.adoption}</SectionHeader>
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
          <SectionHeader>{dict.org.skills.commonSequences}</SectionHeader>
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
