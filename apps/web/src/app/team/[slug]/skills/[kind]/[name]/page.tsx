import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TeamSubNav } from '@/app/team/[slug]/layout';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
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

  const maxTrend = Math.max(...trend.map((r) => r.invocationCount), 1);
  const withSkill = costRows.find((r) => r.hasSkill);
  const withoutSkill = costRows.find((r) => !r.hasSkill);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-white/40 uppercase tracking-wider mb-1">
            <span>{teamName}</span>
            {' / '}
            <Link href={`/team/${slug}/skills`} className="hover:text-white/60">
              Skills
            </Link>
            {' / '}
            <span className="capitalize">{kind}</span>
          </p>
          <h1 className="text-2xl font-semibold font-mono">/{name}</h1>
          <p className="mt-1 text-sm text-white/50">Trailing {range} days</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <TeamSubNav slug={slug} active="skills" />

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
          <div key={c.label} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-xs text-white/40 uppercase tracking-wider">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold font-mono">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Daily trend */}
      {trend.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">
            Daily invocations
          </h3>
          <div className="flex items-end gap-1 h-20">
            {trend.map((r) => (
              <div
                key={r.day.toISOString()}
                className="flex-1 bg-accent/60 rounded-t min-h-[2px]"
                style={{ height: `${Math.max((r.invocationCount / maxTrend) * 100, 2)}%` }}
                title={`${r.day.toLocaleDateString()}: ${r.invocationCount} invocations`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Cost impact */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-xs text-white/40 uppercase tracking-widest mb-4">Cost impact</h3>
        {costRows.length > 0 ? (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/70">Sessions using /{name}</span>
              <span className="font-mono text-sm text-white">
                {withSkill ? `$${withSkill.avgCostUsd.toFixed(3)}` : '—'}
                <span className="text-white/30 text-xs ml-2">
                  ({withSkill?.sessionCount ?? 0} sessions)
                </span>
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/70">Sessions without</span>
              <span className="font-mono text-sm text-white/60">
                {withoutSkill ? `$${withoutSkill.avgCostUsd.toFixed(3)}` : '—'}
                <span className="text-white/30 text-xs ml-2">
                  ({withoutSkill?.sessionCount ?? 0} sessions)
                </span>
              </span>
            </div>
            {withSkill && withoutSkill && (
              <div className="pt-2 border-t border-white/10">
                <p className="text-xs text-white/40">
                  {withSkill.avgCostUsd > withoutSkill.avgCostUsd
                    ? `Sessions using /${name} cost ${((withSkill.avgCostUsd / withoutSkill.avgCostUsd - 1) * 100).toFixed(0)}% more on average — longer or more complex tasks.`
                    : `Sessions using /${name} cost ${((1 - withSkill.avgCostUsd / withoutSkill.avgCostUsd) * 100).toFixed(0)}% less on average.`}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-white/30">No cost data available</p>
        )}
      </div>

      {/* Top users */}
      {topUsers.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">Top users</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-xs border-b border-white/10">
                <th className="text-left pb-2">Member</th>
                <th className="text-right pb-2 font-mono">Invocations</th>
                <th className="text-right pb-2 font-mono">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {topUsers.map((u) => (
                <tr key={u.githubLogin} className="border-b border-white/5">
                  <td className="py-2">
                    <Link
                      href={`/team/${slug}/member/${u.githubLogin}`}
                      className="text-white/80 hover:text-white"
                    >
                      {u.displayName ?? u.githubLogin}
                    </Link>
                    {u.displayName && <p className="text-xs text-white/40">@{u.githubLogin}</p>}
                  </td>
                  <td className="py-2 text-right font-mono text-white/70">
                    {u.invocationCount.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono text-white/50">{u.sessionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
