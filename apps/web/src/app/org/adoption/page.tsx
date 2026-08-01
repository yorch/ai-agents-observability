import { PageHeader } from '@/components/team-org/PageHeader';
import { Stat } from '@/components/ui';
import {
  getActiveUsersTrend,
  getAdoptionByTeam,
  getOrgSummary,
  getSessionFrequencyDistribution,
} from '@/lib/org-queries';
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

export default async function OrgAdoptionPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { orgRole } = await requireOrgViewer();
  const isAdmin = isOrgAdmin(orgRole);

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);

  const [summary, weeklyTrend, adoptionByTeam, frequencyDist] = await Promise.all([
    getOrgSummary(since),
    getActiveUsersTrend(since, 'week'),
    getAdoptionByTeam(since),
    getSessionFrequencyDistribution(since),
  ]);

  const maxFreq = Math.max(...frequencyDist.map((b) => b.userCount), 1);
  const totalUsersInDist = frequencyDist.reduce((s, b) => s + b.userCount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`How the org is ramping on AI coding agents · trailing ${range} days`}
        range={range}
        title="Adoption"
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={`Active users (${range}d)`} value={summary.activeUsers.toString()} />
        <Stat label={`Total sessions (${range}d)`} value={summary.sessionCount.toString()} />
        <Stat
          label={`Sessions / user (${range}d)`}
          value={
            summary.activeUsers > 0 ? (summary.sessionCount / summary.activeUsers).toFixed(1) : '—'
          }
        />
        <Stat
          label={`Avg cost / session (${range}d)`}
          value={
            summary.sessionCount > 0 && summary.totalCostUsd > 0
              ? `$${(summary.totalCostUsd / summary.sessionCount).toFixed(2)}`
              : '—'
          }
        />
      </div>

      {/* Weekly active users trend */}
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-text-2 mb-4">
          Weekly active users (trailing {range} days)
        </h2>
        {weeklyTrend.length === 0 ? (
          <p className="text-sm text-text-3">No data yet.</p>
        ) : (
          <ActiveUsersBars trend={weeklyTrend} />
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Session frequency distribution */}
        <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text-2">Session frequency ({range}d)</h2>
          <p className="text-xs text-text-3">
            Among org-sharing users — how often are they using Claude Code?
          </p>
          {totalUsersInDist === 0 ? (
            <p className="text-sm text-text-3">No data.</p>
          ) : (
            <div className="space-y-2 pt-1">
              {frequencyDist.map((b) => {
                const pct = totalUsersInDist > 0 ? (b.userCount / totalUsersInDist) * 100 : 0;
                const barWidth = maxFreq > 0 ? (b.userCount / maxFreq) * 100 : 0;
                return (
                  <div key={b.bucket} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-2">{b.bucket}</span>
                      <span className="text-text-2">
                        {b.userCount} users · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-2">
                      <div
                        className={`h-full rounded-full ${b.bucket === 'Inactive' ? 'bg-surface-3' : 'bg-brand-500/70'}`}
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
        <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text-2">Team adoption rate ({range}d)</h2>
          <p className="text-xs text-text-3">
            Active members / total team members with sessions in the window.
          </p>
          {adoptionByTeam.length === 0 ? (
            <p className="text-sm text-text-3">No team data available.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-3 text-left">
                  <th className="pb-2 font-medium">Team</th>
                  <th className="pb-2 font-medium text-right">Active</th>
                  <th className="pb-2 font-medium text-right">Total</th>
                  <th className="pb-2 font-medium text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
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
                    <td className="py-2 text-right text-text-2">{t.activeUsers}</td>
                    <td className="py-2 text-right text-text-2">{t.totalMembers}</td>
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

      <p className="text-xs text-text-3 text-center pt-2">
        Only users who have opted into org-level metadata sharing are counted in these aggregates.
      </p>
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
            <span className="text-[10px] text-text-3">{t.activeUsers}</span>
            <div
              className="w-full rounded-t bg-brand-500/70 min-h-1"
              style={{ height: `${height}px` }}
              title={`${label}: ${t.activeUsers} active users`}
            />
            <span className="text-[9px] text-text-3">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function AdoptionBadge({ rate }: { rate: number }) {
  const pct = (rate * 100).toFixed(0);
  const color = rate >= 0.7 ? 'text-good' : rate >= 0.4 ? 'text-warn' : 'text-text-3';
  return <span className={`font-mono ${color}`}>{pct}%</span>;
}
