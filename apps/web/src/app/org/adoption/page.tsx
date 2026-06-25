import {
  getActiveUsersTrend,
  getAdoptionByTeam,
  getOrgSummary,
  getSessionFrequencyDistribution,
} from '@/lib/org-queries';
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
import { OrgSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function OrgAdoptionPage() {
  const { orgRole } = await requireOrgViewer();
  const isAdmin = isOrgAdmin(orgRole);

  const since30 = daysAgo(30);
  const since90 = daysAgo(90);

  const [summary30, summary90, weeklyTrend, adoptionByTeam, frequencyDist] = await Promise.all([
    getOrgSummary(since30),
    getOrgSummary(since90),
    getActiveUsersTrend(since90, 'week'),
    getAdoptionByTeam(since30),
    getSessionFrequencyDistribution(since30),
  ]);

  const _adoptionRate =
    summary30.activeUsers > 0 && summary90.activeUsers > 0
      ? summary30.activeUsers / Math.max(summary30.activeUsers, summary90.activeUsers)
      : 0;

  const maxFreq = Math.max(...frequencyDist.map((b) => b.userCount), 1);
  const totalUsersInDist = frequencyDist.reduce((s, b) => s + b.userCount, 0);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Org</p>
        <h1 className="text-2xl font-semibold">Adoption</h1>
        <p className="mt-1 text-sm text-white/50">
          How the org is ramping on AI coding agents · trailing 30 / 90 days
        </p>
      </div>

      <OrgSubNav active="adoption" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Active users (30d)" value={summary30.activeUsers.toString()} />
        <StatCard label="Active users (90d)" value={summary90.activeUsers.toString()} />
        <StatCard label="Total sessions (30d)" value={summary30.sessionCount.toString()} />
        <StatCard
          label="Sessions / user (30d)"
          value={
            summary30.activeUsers > 0
              ? (summary30.sessionCount / summary30.activeUsers).toFixed(1)
              : '—'
          }
        />
      </div>

      {/* Weekly active users trend */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-semibold text-white/70 mb-4">
          Weekly active users (trailing 90 days)
        </h2>
        {weeklyTrend.length === 0 ? (
          <p className="text-sm text-white/40">No data yet.</p>
        ) : (
          <ActiveUsersBars trend={weeklyTrend} />
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Session frequency distribution */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Session frequency (30d)</h2>
          <p className="text-xs text-white/40">
            Among org-sharing users — how often are they using Claude Code?
          </p>
          {totalUsersInDist === 0 ? (
            <p className="text-sm text-white/40">No data.</p>
          ) : (
            <div className="space-y-2 pt-1">
              {frequencyDist.map((b) => {
                const pct = totalUsersInDist > 0 ? (b.userCount / totalUsersInDist) * 100 : 0;
                const barWidth = maxFreq > 0 ? (b.userCount / maxFreq) * 100 : 0;
                return (
                  <div key={b.bucket} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-white/70">{b.bucket}</span>
                      <span className="text-white/50">
                        {b.userCount} users · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full ${b.bucket === 'Inactive' ? 'bg-white/20' : 'bg-brand-500/70'}`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Adoption by team */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Team adoption rate (30d)</h2>
          <p className="text-xs text-white/40">
            Active members / total team members with sessions in the window.
          </p>
          {adoptionByTeam.length === 0 ? (
            <p className="text-sm text-white/40">No team data available.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 text-left">
                  <th className="pb-2 font-medium">Team</th>
                  <th className="pb-2 font-medium text-right">Active</th>
                  <th className="pb-2 font-medium text-right">Total</th>
                  <th className="pb-2 font-medium text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {adoptionByTeam.map((t) => (
                  <tr key={t.teamSlug}>
                    <td className="py-2">
                      {isAdmin ? (
                        <a href={`/team/${t.teamSlug}`} className="text-brand-400 hover:underline">
                          {t.teamName}
                        </a>
                      ) : (
                        t.teamName
                      )}
                    </td>
                    <td className="py-2 text-right text-white/60">{t.activeUsers}</td>
                    <td className="py-2 text-right text-white/60">{t.totalMembers}</td>
                    <td className="py-2 text-right">
                      <AdoptionBadge rate={t.adoptionRate} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <p className="text-xs text-white/30 text-center pt-2">
        Only users who have opted into org-level metadata sharing are counted in these aggregates.
      </p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-1">
      <p className="text-xs text-white/50">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function ActiveUsersBars({ trend }: { trend: { activeUsers: number; day: Date }[] }) {
  const max = Math.max(...trend.map((t) => t.activeUsers), 1);
  return (
    <div className="flex items-end gap-1 h-24">
      {trend.map((t) => {
        const height = Math.max(4, (t.activeUsers / max) * 96);
        const label = new Date(t.day).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
        });
        return (
          <div key={t.day.toISOString()} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[10px] text-white/40">{t.activeUsers}</span>
            <div
              className="w-full rounded-t bg-brand-500/70 min-h-1"
              style={{ height: `${height}px` }}
              title={`${label}: ${t.activeUsers} active users`}
            />
            <span className="text-[9px] text-white/30">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function AdoptionBadge({ rate }: { rate: number }) {
  const pct = (rate * 100).toFixed(0);
  const color = rate >= 0.7 ? 'text-green-400' : rate >= 0.4 ? 'text-yellow-400' : 'text-white/40';
  return <span className={`font-mono ${color}`}>{pct}%</span>;
}
