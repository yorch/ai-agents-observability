import Link from 'next/link';
import { OrgSubNav } from '@/app/org/layout';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
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
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Organization</p>
          <h1 className="text-2xl font-semibold">Skills</h1>
          <p className="mt-1 text-sm text-white/50">Trailing {range} days</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <OrgSubNav active="skills" />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Unique skills', value: skills.length.toString() },
          { label: 'Total invocations', value: totalInvocations.toLocaleString() },
          { label: 'Active adopters', value: uniqueAdopters.toString() },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-xs text-white/40 uppercase tracking-wider">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold font-mono">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Daily invocation trend */}
      {trend.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">
            Daily invocations
          </h3>
          <div className="flex items-end gap-1 h-16">
            {trend.map((r) => (
              <div
                key={r.day.toISOString()}
                className="flex-1 bg-accent/60 rounded-t"
                style={{ height: `${(r.invocationCount / maxTrend) * 100}%` }}
                title={`${r.day.toLocaleDateString()}: ${r.invocationCount}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Skills table */}
      {skills.length > 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">All skills</h3>
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
                <tr
                  key={`${r.kind}:${r.name}`}
                  className="border-b border-white/5 hover:bg-white/5"
                >
                  <td className="py-2">
                    <Link
                      href={`/org/skills/${r.kind}/${encodeURIComponent(r.name)}`}
                      className="font-mono text-accent hover:text-accent/70"
                    >
                      /{r.name}
                    </Link>
                  </td>
                  <td className="py-2 text-xs text-white/40 capitalize">{r.kind}</td>
                  <td className="py-2 text-right font-mono text-white/70">
                    {r.callCount.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono text-white/60">{r.distinctUsers}</td>
                  <td className="py-2 text-right font-mono text-white/50">
                    {r.avgSessionCostUsd != null ? `$${r.avgSessionCostUsd.toFixed(3)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center text-sm text-white/40">
          No skill activity in this period
        </div>
      )}

      {/* Adoption funnel */}
      {funnel.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">
            Adoption — new vs returning users
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-xs border-b border-white/10">
                <th className="text-left pb-2">Skill</th>
                <th className="text-right pb-2 font-mono">Active users</th>
                <th className="text-right pb-2 font-mono">New</th>
                <th className="text-right pb-2 font-mono">Returning</th>
              </tr>
            </thead>
            <tbody>
              {funnel.map((r) => (
                <tr key={r.name} className="border-b border-white/5">
                  <td className="py-2 font-mono text-white/80">/{r.name}</td>
                  <td className="py-2 text-right font-mono text-white/70">{r.recentUsers}</td>
                  <td className="py-2 text-right font-mono text-emerald-400">{r.newUsers}</td>
                  <td className="py-2 text-right font-mono text-white/50">{r.returningUsers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Skill sequences */}
      {sequences.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h3 className="text-xs text-white/40 uppercase tracking-widest mb-3">
            Common skill sequences
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-xs border-b border-white/10">
                <th className="text-left pb-2">From</th>
                <th className="text-left pb-2">To</th>
                <th className="text-right pb-2 font-mono">Transitions</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((r) => (
                <tr key={`${r.fromSkill}->${r.toSkill}`} className="border-b border-white/5">
                  <td className="py-2 font-mono text-white/70">/{r.fromSkill}</td>
                  <td className="py-2 font-mono text-white/70">/{r.toSkill}</td>
                  <td className="py-2 text-right font-mono text-white/50">
                    {r.transitionCount.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-white/30">
            Most frequent skill-to-skill transitions within the same session.
          </p>
        </div>
      )}
    </div>
  );
}
