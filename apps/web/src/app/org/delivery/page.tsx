import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import {
  getOrgCheckHealth,
  getOrgPRDeliveryStats,
  getOrgReviewHealth,
  getPRWeeklyTrend,
  getTopReposByPR,
} from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

function fmtHours(hours: number | null): string {
  if (hours == null) {
    return '—';
  }
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  return `${(hours / 24).toFixed(1)}d`;
}

export default async function OrgDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 90) as 7 | 30 | 90;
  const since = daysAgo(range);
  const trendWeeks = range === 7 ? 4 : range === 30 ? 12 : 26;

  const [stats, weeklyTrend, topRepos, reviews, checkHealth] = await Promise.all([
    getOrgPRDeliveryStats(since),
    getPRWeeklyTrend(trendWeeks),
    getTopReposByPR(since),
    getOrgReviewHealth(since),
    getOrgCheckHealth(since),
  ]);

  const maxPRs = Math.max(...weeklyTrend.map((w) => w.mergedPRs), 1);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`PR throughput, cycle time, and cost · trailing ${range} days`}
        range={range}
        title="Delivery"
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label={`PRs opened (${range}d)`}
          value={stats.totalPRs.toString()}
          sub={`${stats.mergedPRs} merged`}
        />
        <StatCard
          label="Merge rate"
          value={`${(stats.mergeRate * 100).toFixed(0)}%`}
          {...(stats.totalPRs > 0 ? { sub: `${stats.totalPRs - stats.mergedPRs} unmerged` } : {})}
        />
        <StatCard
          label="Median time-to-merge"
          value={fmtHours(stats.medianTimeToMergeHours)}
          sub="from open to merge"
        />
        <StatCard
          label="Avg cost / PR"
          value={stats.avgCostPerPR > 0 ? `$${stats.avgCostPerPR.toFixed(2)}` : '—'}
          {...(stats.medianCostPerPR != null
            ? { sub: `median $${stats.medianCostPerPR.toFixed(2)}` }
            : {})}
        />
      </div>

      {/* Revert signal */}
      {stats.mergedPRs > 0 && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            stats.revertRate > 0.05
              ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300'
              : 'border-white/10 bg-white/5 text-white/60'
          }`}
        >
          <span className="font-semibold">Revert rate:</span> {(stats.revertRate * 100).toFixed(1)}%
          ({stats.revertedPRs} of {stats.mergedPRs} merged PRs reverted)
          {stats.revertRate > 0.05 && ' — above 5% threshold, worth investigating.'}
        </div>
      )}

      {/* Weekly PR trend */}
      {weeklyTrend.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-semibold text-white/70 mb-4">
            Weekly merged PRs ({trendWeeks} weeks)
          </h2>
          <div className="flex items-end gap-1 h-24">
            {weeklyTrend.map((w) => {
              const height = Math.max(4, (w.mergedPRs / maxPRs) * 96);
              const label = new Date(w.week).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
              });
              return (
                <div key={w.week.toISOString()} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-[10px] text-white/40">{w.mergedPRs}</span>
                  <div
                    className="w-full rounded-t bg-brand-500/70 min-h-1"
                    style={{ height: `${height}px` }}
                    title={`${label}: ${w.mergedPRs} PRs · $${w.totalCostUsd.toFixed(2)} total`}
                  />
                  <span className="text-[9px] text-white/30">{label}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Review health */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Review health ({range}d)</h2>
        {reviews.reviewedPrs === 0 ? (
          <p className="text-sm text-white/40">
            No submitted reviews recorded in this window. Review data arrives via the
            pull_request_review webhook.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              label="Median time to first review"
              value={fmtHours(reviews.medianHoursToFirstReview)}
              sub="from PR open to first submitted review"
            />
            <StatCard
              label="Reviews / PR"
              value={reviews.avgReviewsPerPr.toFixed(1)}
              sub={`${reviews.totalReviews} reviews on ${reviews.reviewedPrs} PRs`}
            />
            <StatCard
              label="Reviewed PRs"
              value={String(reviews.reviewedPrs)}
              sub="PRs with at least one submitted review"
            />
          </div>
        )}
      </section>

      {/* CI check health */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Failing CI checks ({range}d)</h2>
        {checkHealth.length === 0 ? (
          <p className="text-sm text-white/40">
            No failing check runs recorded in this window. Per-run outcomes arrive via the check_run
            webhook.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Check</th>
                <th className="pb-2 font-medium text-right">Runs</th>
                <th className="pb-2 font-medium text-right">Failures</th>
                <th className="pb-2 font-medium text-right">Failure rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {checkHealth.map((c) => (
                <tr key={c.checkName}>
                  <td className="py-2 font-mono text-xs text-white/80">{c.checkName}</td>
                  <td className="py-2 text-right text-white/60">{c.totalRuns}</td>
                  <td className="py-2 text-right text-white/60">{c.failures}</td>
                  <td
                    className={`py-2 text-right font-mono ${
                      c.failureRate > 0.3 ? 'text-yellow-300' : 'text-white/60'
                    }`}
                  >
                    {(c.failureRate * 100).toFixed(0)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-white/30">
          Checks that fail often on agent-linked PRs are either guarding real quality issues or
          flaky — both worth investigating.
        </p>
      </section>

      {/* Top repos by PR activity */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Top repos by merged PRs ({range}d)</h2>
        {topRepos.length === 0 ? (
          <p className="text-sm text-white/40">No merged PR data available.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Repo</th>
                <th className="pb-2 font-medium text-right">Merged PRs</th>
                <th className="pb-2 font-medium text-right">Median TTM</th>
                <th className="pb-2 font-medium text-right">Avg cost / PR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {topRepos.map((r) => (
                <tr key={`${r.repoOwner}/${r.repoName}`}>
                  <td className="py-2 font-mono text-xs text-white/80">
                    {r.repoOwner}/{r.repoName}
                  </td>
                  <td className="py-2 text-right text-white/60">{r.mergedPRs}</td>
                  <td className="py-2 text-right text-white/60">
                    {fmtHours(r.medianTimeToMergeHours)}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {r.avgCostUsd > 0 ? `$${r.avgCostUsd.toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-white/30 text-center pt-2">
        PR cost reflects sessions from users who share metadata with the org. TTM = time from PR
        open to merge.
      </p>
    </div>
  );
}
