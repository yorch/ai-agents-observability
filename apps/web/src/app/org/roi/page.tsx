import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { getConfig } from '@/lib/config';
import {
  getCiCostCorrelation,
  getOrgRoiSummary,
  getRoiByRepo,
  getSpendByJiraKey,
} from '@/lib/roi-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function OrgRoiPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 90) as 7 | 30 | 90;
  const since = daysAgo(range);

  const [summary, ci, jiraSpend, repoRoi] = await Promise.all([
    getOrgRoiSummary(since),
    getCiCostCorrelation(since),
    getSpendByJiraKey(since),
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
          value={usd(summary.totalSpendUsd)}
          sub={`${summary.mergedPrs} PRs merged`}
        />
        <StatCard
          label="Cost / merged PR"
          value={summary.costPerMergedPr > 0 ? usd(summary.costPerMergedPr) : '—'}
          sub="merged-PR spend ÷ merged PRs"
        />
        <StatCard
          label="Reverted spend"
          value={usd(summary.revertedSpendUsd)}
          sub={`${pct(summary.revertedSpendShare)} of spend · ${summary.revertedPrs} PRs`}
          {...(summary.revertedSpendShare > 0.05 ? { accent: 'red' as const } : {})}
        />
        <StatCard
          label="CI-clean merge rate"
          value={pct(summary.ciCleanMergeRate)}
          sub="merged with no failing checks"
          {...(summary.ciCleanMergeRate < 0.8 && summary.mergedPrs > 0
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
                value={ci.cleanAvgCost > 0 ? usd(ci.cleanAvgCost) : '—'}
                sub={`avg cost · ${ci.cleanCount} PRs`}
                accent="green"
              />
              <StatCard
                label="CI-failed merges"
                value={ci.failedAvgCost > 0 ? usd(ci.failedAvgCost) : '—'}
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

      {/* Spend by Jira initiative */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Spend by Jira initiative ({range}d)</h2>
        {jiraSpend.length === 0 ? (
          <p className="text-sm text-white/40">
            No PRs with a Jira key in this window. Jira keys are extracted from PR branch names.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Jira key</th>
                <th className="pb-2 font-medium text-right">PRs</th>
                <th className="pb-2 font-medium text-right">Merged</th>
                <th className="pb-2 font-medium text-right">Agent spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {jiraSpend.map((j) => (
                <tr key={j.jiraKey}>
                  <td className="py-2 font-mono text-xs">
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
                  </td>
                  <td className="py-2 text-right text-white/60">{j.prCount}</td>
                  <td className="py-2 text-right text-white/60">{j.mergedPrs}</td>
                  <td className="py-2 text-right font-mono">{usd(j.totalCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
                  <td className="py-2 text-right font-mono">{usd(r.mergedSpendUsd)}</td>
                  <td className="py-2 text-right font-mono">{usd(r.costPerMergedPr)}</td>
                  <td
                    className={`py-2 text-right font-mono ${r.revertRate > 0.05 ? 'text-yellow-300' : 'text-white/60'}`}
                  >
                    {pct(r.revertRate)}
                  </td>
                  <td
                    className={`py-2 text-right font-mono ${r.ciCleanRate < 0.8 ? 'text-yellow-300' : 'text-white/60'}`}
                  >
                    {pct(r.ciCleanRate)}
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
