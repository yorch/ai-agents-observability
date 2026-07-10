import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { getConfig } from '@/lib/config';
import { fmtPct, fmtUsd } from '@/lib/fmt';
import {
  getCiCostCorrelation,
  getCommitProvenance,
  getOrgRoiSummary,
  getRoiByRepo,
  getSpendByEpic,
  getSpendByJiraKey,
} from '@/lib/roi-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// Health thresholds, shared by the headline cards and the per-row table cells so a
// single policy change can't leave the two views disagreeing.
const HIGH_REVERT_RATE = 0.05;
const LOW_CI_CLEAN_RATE = 0.8;

export default async function OrgRoiPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 90) as 7 | 30 | 90;
  const since = daysAgo(range);

  const [summary, ci, jiraSpend, epicSpend, commits, repoRoi] = await Promise.all([
    getOrgRoiSummary(since),
    getCiCostCorrelation(since),
    getSpendByJiraKey(since),
    getSpendByEpic(since),
    getCommitProvenance(since),
    getRoiByRepo(since),
  ]);

  const jiraBase = getConfig().jiraBaseUrl?.replace(/\/$/, '') ?? null;
  // Multiplier of how much more a CI-failed merge cost vs a clean one.
  const ciCostMultiplier =
    ci.cleanAvgCost > 0 && ci.failedAvgCost > 0 ? ci.failedAvgCost / ci.cleanAvgCost : null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Agent spend joined to delivery outcomes · trailing ${range} days`}
        range={range}
        title="ROI"
      />

      {/* Headline ROI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label={`Agent spend (${range}d)`}
          value={fmtUsd(summary.totalSpendUsd)}
          sub={`${summary.mergedPrs} PRs merged`}
        />
        <StatCard
          label="Cost / merged PR"
          value={summary.costPerMergedPr > 0 ? fmtUsd(summary.costPerMergedPr) : '—'}
          sub="merged-PR spend ÷ merged PRs"
        />
        <StatCard
          label="Reverted spend"
          value={fmtUsd(summary.revertedSpendUsd)}
          sub={`${fmtPct(summary.revertedSpendShare)} of spend · ${summary.revertedPrs} PRs`}
          {...(summary.revertedSpendShare > HIGH_REVERT_RATE ? { accent: 'red' as const } : {})}
        />
        <StatCard
          label="CI-clean merge rate"
          value={fmtPct(summary.ciCleanMergeRate)}
          sub="merged with no failing checks"
          {...(summary.ciCleanMergeRate < LOW_CI_CLEAN_RATE && summary.mergedPrs > 0
            ? { accent: 'amber' as const }
            : {})}
        />
      </div>

      {/* CI outcome cost correlation */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">CI outcome vs cost</h2>
        {ci.cleanCount === 0 && ci.failedCount === 0 ? (
          <p className="text-sm text-white/40">No merged PRs with cost data in this window.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <StatCard
                label="Clean-CI merges"
                value={ci.cleanAvgCost > 0 ? fmtUsd(ci.cleanAvgCost) : '—'}
                sub={`avg cost · ${ci.cleanCount} PRs`}
                accent="green"
              />
              <StatCard
                label="CI-failed merges"
                value={ci.failedAvgCost > 0 ? fmtUsd(ci.failedAvgCost) : '—'}
                sub={`avg cost · ${ci.failedCount} PRs`}
                {...(ciCostMultiplier && ciCostMultiplier > 1 ? { accent: 'amber' as const } : {})}
              />
            </div>
            {ciCostMultiplier && ciCostMultiplier > 1 && (
              <p className="text-sm text-white/60">
                PRs that hit a failing check before merging cost{' '}
                <span className="font-semibold text-yellow-300">
                  {ciCostMultiplier.toFixed(1)}×
                </span>{' '}
                more agent spend on average than clean-CI merges.
              </p>
            )}
          </>
        )}
      </section>

      {/* Spend by Jira ticket */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Spend by Jira ticket ({range}d)</h2>
        {jiraSpend.length === 0 ? (
          <p className="text-sm text-white/40">
            No PRs or sessions with a Jira key in this window. Jira keys are extracted from branch
            names, PR titles, and PR bodies.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Ticket</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium text-right">PRs</th>
                <th className="pb-2 font-medium text-right">Merged</th>
                <th className="pb-2 font-medium text-right">Sessions</th>
                <th className="pb-2 font-medium text-right">Session spend</th>
                <th className="pb-2 font-medium text-right">PR spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {jiraSpend.map((j) => (
                <tr key={j.jiraKey}>
                  <td className="py-2">
                    <span className="font-mono text-xs">
                      {jiraBase ? (
                        <a
                          href={`${jiraBase}/browse/${j.jiraKey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300"
                        >
                          {j.jiraKey}
                        </a>
                      ) : (
                        <span className="text-white/80">{j.jiraKey}</span>
                      )}
                    </span>
                    {j.summary && (
                      <span className="ml-2 text-xs text-white/50">
                        {j.summary.length > 60 ? `${j.summary.slice(0, 60)}…` : j.summary}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-white/50">
                    {j.status ?? '—'}
                    {j.issueType ? ` · ${j.issueType}` : ''}
                  </td>
                  <td className="py-2 text-right text-white/60">{j.prCount}</td>
                  <td className="py-2 text-right text-white/60">{j.mergedPrs}</td>
                  <td className="py-2 text-right text-white/60">{j.sessionCount}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(j.sessionCostUsd)}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(j.totalCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-white/30">
          Session spend counts every session on the ticket's branch — including work that never
          reached a PR. PR spend is the rollup of sessions linked to the ticket's PRs. Ticket
          status/summary appear once the Jira sync job is configured.
        </p>
      </section>

      {/* Spend by epic */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Spend by epic ({range}d)</h2>
        {epicSpend.length === 0 ? (
          <p className="text-sm text-white/40">
            No epic-level data. Epics require the Jira sync job (JIRA_BASE_URL + JIRA_API_TOKEN) to
            have resolved ticket metadata.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Epic</th>
                <th className="pb-2 font-medium text-right">Tickets</th>
                <th className="pb-2 font-medium text-right">Merged PRs</th>
                <th className="pb-2 font-medium text-right">Session spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {epicSpend.map((e) => (
                <tr key={e.epicKey}>
                  <td className="py-2">
                    <span className="font-mono text-xs">
                      {jiraBase ? (
                        <a
                          href={`${jiraBase}/browse/${e.epicKey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300"
                        >
                          {e.epicKey}
                        </a>
                      ) : (
                        <span className="text-white/80">{e.epicKey}</span>
                      )}
                    </span>
                    {e.epicSummary && (
                      <span className="ml-2 text-xs text-white/50">
                        {e.epicSummary.length > 60
                          ? `${e.epicSummary.slice(0, 60)}…`
                          : e.epicSummary}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right text-white/60">{e.ticketCount}</td>
                  <td className="py-2 text-right text-white/60">{e.mergedPrs}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(e.sessionCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Merged-work provenance */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Merged-work provenance ({range}d)</h2>
        <div className="grid grid-cols-2 gap-4">
          <StatCard
            label="Agent-touched commits"
            value={String(commits.linkedCommits)}
            sub="default-branch commits attributed to a session"
          />
          <StatCard
            label="Sessions with merged commits"
            value={String(commits.sessionsWithCommits)}
            sub="sessions whose work landed on the default branch"
          />
        </div>
        <p className="text-xs text-white/30">
          Attribution matches default-branch pushes to sessions by repo, author, and time window —
          it requires the code to have survived review, unlike lines-of-code metrics.
        </p>
      </section>

      {/* ROI by repo */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">ROI by repo ({range}d)</h2>
        {repoRoi.length === 0 ? (
          <p className="text-sm text-white/40">No merged PR data available.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Repo</th>
                <th className="pb-2 font-medium text-right">Merged</th>
                <th className="pb-2 font-medium text-right">Spend</th>
                <th className="pb-2 font-medium text-right">Cost / PR</th>
                <th className="pb-2 font-medium text-right">Revert rate</th>
                <th className="pb-2 font-medium text-right">CI-clean</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {repoRoi.map((r) => (
                <tr key={`${r.repoOwner}/${r.repoName}`}>
                  <td className="py-2 font-mono text-xs text-white/80">
                    {r.repoOwner}/{r.repoName}
                  </td>
                  <td className="py-2 text-right text-white/60">{r.mergedPrs}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(r.mergedSpendUsd)}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(r.costPerMergedPr)}</td>
                  <td
                    className={`py-2 text-right font-mono ${r.revertRate > HIGH_REVERT_RATE ? 'text-yellow-300' : 'text-white/60'}`}
                  >
                    {fmtPct(r.revertRate)}
                  </td>
                  <td
                    className={`py-2 text-right font-mono ${r.ciCleanRate < LOW_CI_CLEAN_RATE ? 'text-yellow-300' : 'text-white/60'}`}
                  >
                    {fmtPct(r.ciCleanRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-white/30 text-center pt-2">
        Spend is the agent cost rolled up to each PR from its contributing sessions. Reverted spend
        is cost that went into PRs later reverted — a rework signal, not necessarily waste.
      </p>
    </div>
  );
}
