import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DailyTrendBars } from '@/components/team-org/DailyTrendBars';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { Card, Cell, Row, Table } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamSkillCostComparison,
  getTeamSkillDailyTrend,
  getTeamSkillTopUsers,
  getTeamSkillUsage,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function TeamSkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; kind: string; name: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug, kind: rawKind, name: encodedName } = await params;
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  if (rawKind !== 'skill' && rawKind !== 'slash') {
    notFound();
  }
  const kind = rawKind as 'skill' | 'slash';
  const name = decodeURIComponent(encodedName);

  const { teamId, teamName } = await requireTeamLead(slug);
  const since = daysAgo(range);

  const { visibleIds } = await resolveTeamVisibility(teamId);
  const [allSkills, trend, topUsers, costRows] = await Promise.all([
    getTeamSkillUsage(visibleIds, since),
    getTeamSkillDailyTrend(visibleIds, name, kind, since),
    getTeamSkillTopUsers(visibleIds, name, kind, since),
    getTeamSkillCostComparison(visibleIds, name, kind, since),
  ]);

  const stat = allSkills.find((s) => s.name === name && s.kind === kind);
  if (!stat && trend.length === 0) {
    notFound();
  }
  const withSkill = costRows.find((r) => r.hasSkill);
  const withoutSkill = costRows.find((r) => !r.hasSkill);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">
            <span>{teamName}</span>
            {' / '}
            <Link href={`/team/${slug}/skills`} className="hover:text-text-2">
              Skills
            </Link>
            {' / '}
            <span className="capitalize">{kind}</span>
          </p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">/{name}</h1>
          <p className="mt-1 text-sm text-text-2">Trailing {range} days</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Invocations', value: (stat?.callCount ?? 0).toLocaleString() },
          { label: 'Distinct users', value: (stat?.distinctUsers ?? 0).toString() },
          {
            label: 'Avg session cost',
            value: stat?.avgSessionCostUsd != null ? `$${stat.avgSessionCostUsd.toFixed(3)}` : '—',
          },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-text-3 uppercase tracking-wider">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold font-mono">{c.value}</p>
          </div>
        ))}
      </div>

      <DailyTrendBars points={trend.map((r) => ({ count: r.invocationCount, day: r.day }))} />

      {/* Cost impact */}
      <Card>
        <h3 className="text-xs text-text-3 uppercase tracking-widest mb-4">Cost impact</h3>
        {costRows.length > 0 ? (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-text-2">Sessions using /{name}</span>
              <span className="font-mono text-sm text-text">
                {withSkill ? `$${withSkill.avgCostUsd.toFixed(3)}` : '—'}
                <span className="text-text-3 text-xs ml-2">
                  ({withSkill?.sessionCount ?? 0} sessions)
                </span>
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-text-2">Sessions without</span>
              <span className="font-mono text-sm text-text-2">
                {withoutSkill ? `$${withoutSkill.avgCostUsd.toFixed(3)}` : '—'}
                <span className="text-text-3 text-xs ml-2">
                  ({withoutSkill?.sessionCount ?? 0} sessions)
                </span>
              </span>
            </div>
            {withSkill && withoutSkill && (
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-text-3">
                  {withSkill.avgCostUsd > withoutSkill.avgCostUsd
                    ? `Sessions using /${name} cost ${((withSkill.avgCostUsd / withoutSkill.avgCostUsd - 1) * 100).toFixed(0)}% more on average — longer or more complex tasks.`
                    : `Sessions using /${name} cost ${((1 - withSkill.avgCostUsd / withoutSkill.avgCostUsd) * 100).toFixed(0)}% less on average.`}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-3">No cost data available</p>
        )}
      </Card>

      {/* Top users */}
      {topUsers.length > 0 && (
        <Card>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-text-3">
            Top users
          </h3>
          <Table
            columns={[
              { label: 'Member' },
              { align: 'right', label: 'Invocations', mono: true },
              { align: 'right', label: 'Sessions', mono: true },
            ]}
          >
            {topUsers.map((u, i) => (
              <Row key={u.githubLogin ?? i}>
                <Cell>
                  <Link
                    href={`/team/${slug}/member/${u.githubLogin}`}
                    className="text-text hover:text-text"
                  >
                    {u.displayName ?? u.githubLogin}
                  </Link>
                  {u.displayName && <p className="text-xs text-text-3">@{u.githubLogin}</p>}
                </Cell>
                <Cell num className="text-text-2">
                  {u.invocationCount.toLocaleString()}
                </Cell>
                <Cell num className="text-text-2">
                  {u.sessionCount}
                </Cell>
              </Row>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
