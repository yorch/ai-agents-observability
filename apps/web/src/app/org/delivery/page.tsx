import { PageHeader } from '@/components/team-org/PageHeader';
import { Card, CardEmpty, Cell, Row, Stat, Table } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { fmtDayShort, fmtHoursShort } from '@/lib/fmt';
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

export default async function OrgDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { dict } = await getTranslations();

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
        title={dict.org.delivery.title}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label={`PRs opened (${range}d)`}
          value={stats.totalPRs.toString()}
          sub={`${stats.mergedPRs} merged`}
        />
        <Stat
          label={dict.org.delivery.mergeRate}
          value={`${(stats.mergeRate * 100).toFixed(0)}%`}
          {...(stats.totalPRs > 0 ? { sub: `${stats.totalPRs - stats.mergedPRs} unmerged` } : {})}
        />
        <Stat
          label={dict.org.delivery.medianTimeToMerge}
          value={fmtHoursShort(stats.medianTimeToMergeHours)}
          sub="from open to merge"
        />
        <Stat
          label={dict.org.delivery.avgCostPerPr}
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
              ? 'border-warn-line bg-warn-soft text-warn'
              : 'border-border bg-surface text-text-2'
          }`}
        >
          <span className="font-semibold">{dict.org.delivery.revertRate}</span>{' '}
          {(stats.revertRate * 100).toFixed(1)}% ({stats.revertedPRs} of {stats.mergedPRs} merged
          PRs reverted)
          {stats.revertRate > 0.05 && ' — above 5% threshold, worth investigating.'}
        </div>
      )}

      {/* Weekly PR trend */}
      {weeklyTrend.length > 0 && (
        <Card>
          <h2 className="mb-4 font-display text-sm font-semibold text-text">
            Weekly merged PRs ({trendWeeks} weeks)
          </h2>
          <div className="flex items-end gap-1 h-24">
            {weeklyTrend.map((w) => {
              const height = Math.max(4, (w.mergedPRs / maxPRs) * 96);
              const label = fmtDayShort(new Date(w.week));
              return (
                <div key={w.week.toISOString()} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-[10px] text-text-3">{w.mergedPRs}</span>
                  <div
                    className="w-full rounded-t bg-accent-muted min-h-1"
                    style={{ height: `${height}px` }}
                    title={`${label}: ${w.mergedPRs} PRs · $${w.totalCostUsd.toFixed(2)} total`}
                  />
                  <span className="text-[9px] text-text-3">{label}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Review health */}
      <Card contentClassName="space-y-3">
        <h2 className="font-display text-sm font-semibold text-text">
          {format(dict.org.delivery.reviewHealth, { range })}
        </h2>
        {reviews.reviewedPrs === 0 ? (
          <CardEmpty>
            No submitted reviews recorded in this period. Review data arrives via the
            pull_request_review webhook.
          </CardEmpty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label={dict.org.delivery.medianTimeToFirstReview}
              value={fmtHoursShort(reviews.medianHoursToFirstReview)}
              sub="from PR open to first submitted review"
            />
            <Stat
              label={dict.org.delivery.reviewsPerPr}
              value={reviews.avgReviewsPerPr.toFixed(1)}
              sub={`${reviews.totalReviews} reviews on ${reviews.reviewedPrs} PRs`}
            />
            <Stat
              label={dict.org.delivery.reviewedPrs}
              value={String(reviews.reviewedPrs)}
              sub="PRs with at least one submitted review"
            />
          </div>
        )}
      </Card>

      {/* CI check health */}
      <Card contentClassName="space-y-3">
        <h2 className="font-display text-sm font-semibold text-text">
          Failing CI checks ({range}d)
        </h2>
        {checkHealth.length === 0 ? (
          <CardEmpty>
            No failing check runs recorded in this period. Per-run outcomes arrive via the check_run
            webhook.
          </CardEmpty>
        ) : (
          <Table
            columns={[
              { label: 'Check' },
              { align: 'right', label: 'Runs' },
              { align: 'right', label: 'Failures' },
              { align: 'right', label: 'Failure rate' },
            ]}
          >
            {checkHealth.map((c) => (
              <Row key={c.checkName}>
                <Cell className="text-xs text-text">{c.checkName}</Cell>
                <Cell num className="text-text-2">
                  {c.totalRuns}
                </Cell>
                <Cell num className="text-text-2">
                  {c.failures}
                </Cell>
                <Cell
                  num
                  className={`py-2 text-right font-mono ${
                    c.failureRate > 0.3 ? 'text-warn' : 'text-text-2'
                  }`}
                >
                  {(c.failureRate * 100).toFixed(0)}%
                </Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="text-xs text-text-3">
          Checks that fail often on agent-linked PRs are either guarding real quality issues or
          flaky — both worth investigating.
        </p>
      </Card>

      {/* Top repos by PR activity */}
      <Card contentClassName="space-y-3">
        <h2 className="font-display text-sm font-semibold text-text">
          Top repos by merged PRs ({range}d)
        </h2>
        {topRepos.length === 0 ? (
          <CardEmpty>{dict.org.delivery.empty}</CardEmpty>
        ) : (
          <Table
            columns={[
              { label: 'Repo' },
              { align: 'right', label: 'Merged PRs' },
              { align: 'right', label: 'Median TTM' },
              { align: 'right', label: 'Avg cost / PR' },
            ]}
          >
            {topRepos.map((r) => (
              <Row key={`${r.repoOwner}/${r.repoName}`}>
                <Cell className="text-xs text-text">
                  {r.repoOwner}/{r.repoName}
                </Cell>
                <Cell num className="text-text-2">
                  {r.mergedPRs}
                </Cell>
                <Cell num className="text-text-2">
                  {fmtHoursShort(r.medianTimeToMergeHours)}
                </Cell>
                <Cell num>{r.avgCostUsd > 0 ? `$${r.avgCostUsd.toFixed(2)}` : '—'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      <p className="text-xs text-text-3 text-center pt-2">
        PR cost reflects sessions from users who share metadata with the org. TTM = time from PR
        open to merge.
      </p>
    </div>
  );
}
