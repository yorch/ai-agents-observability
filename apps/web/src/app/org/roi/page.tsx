import { JiraLink } from '@/components/JiraLink';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Stat } from '@/components/ui';
import { getConfig, getJiraBase } from '@/lib/config';
import { fmtPct, fmtUsd } from '@/lib/fmt';
import {
  BUG_ISSUE_TYPES,
  getBusinessValueEconomics,
  getCiCostCorrelation,
  getCommitProvenance,
  getOrgRoiSummary,
  getRoiByRepo,
  getSpendByEpic,
  getSpendByIssueType,
  getSpendByJiraKey,
  getSpendByProject,
  getStoryPointEconomics,
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

  const [
    summary,
    ci,
    jiraSpend,
    projectSpend,
    epicSpend,
    issueTypes,
    commits,
    repoRoi,
    storyPoints,
    bizValue,
  ] = await Promise.all([
    getOrgRoiSummary(since),
    getCiCostCorrelation(since),
    getSpendByJiraKey(since),
    getSpendByProject(since),
    getSpendByEpic(since),
    getSpendByIssueType(since),
    getCommitProvenance(since),
    getRoiByRepo(since),
    getStoryPointEconomics(since),
    getBusinessValueEconomics(since),
  ]);

  const jiraBase = getJiraBase();

  // Business-value join (Part 2): value delivered = story points × the configured
  // per-point rate, compared against agent spend on the same estimated tickets.
  // The whole section is hidden when VALUE_PER_STORY_POINT is unset.
  const valuePerPoint = getConfig().valuePerStoryPoint;
  const businessValue = (valuePerPoint ?? 0) * storyPoints.totalStoryPoints;

  // FU2: prefer the real per-issue value synced from Jira (a true external join)
  // over the flat story-point proxy above, whenever the sync has populated it.
  const hasRealValue = bizValue.totalValueUsd > 0;
  const valueDeliveredUsd = hasRealValue ? bizValue.totalValueUsd : businessValue;
  const valueSpendUsd = hasRealValue ? bizValue.sessionCostUsd : storyPoints.sessionCostUsd;
  const valueReturnMultiple = valueSpendUsd > 0 ? valueDeliveredUsd / valueSpendUsd : 0;

  // Bug-work share: spend on Bug/Defect-type tickets over all *classified*
  // ticket spend (Unclassified is excluded from the denominator so an unsynced
  // Jira doesn't masquerade as "0% bug work").
  const classified = issueTypes.filter((t) => t.issueType !== 'Unclassified');
  const classifiedSpend = classified.reduce((sum, t) => sum + t.sessionCostUsd, 0);
  const bugSpend = classified
    .filter((t) => BUG_ISSUE_TYPES.has(t.issueType.toLowerCase()))
    .reduce((sum, t) => sum + t.sessionCostUsd, 0);
  const bugShare = classifiedSpend > 0 ? bugSpend / classifiedSpend : null;
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
        <Stat
          label={`Agent spend (${range}d)`}
          value={fmtUsd(summary.totalSpendUsd)}
          sub={`${summary.mergedPrs} PRs merged`}
        />
        <Stat
          label="Cost / merged PR"
          value={summary.costPerMergedPr > 0 ? fmtUsd(summary.costPerMergedPr) : '—'}
          sub="merged-PR spend ÷ merged PRs"
        />
        <Stat
          label="Reverted spend"
          value={fmtUsd(summary.revertedSpendUsd)}
          sub={`${fmtPct(summary.revertedSpendShare)} of spend · ${summary.revertedPrs} PRs`}
          {...(summary.revertedSpendShare > HIGH_REVERT_RATE ? { accent: 'crit' as const } : {})}
        />
        <Stat
          label="CI-clean merge rate"
          value={fmtPct(summary.ciCleanMergeRate)}
          sub="merged with no failing checks"
          {...(summary.ciCleanMergeRate < LOW_CI_CLEAN_RATE && summary.mergedPrs > 0
            ? { accent: 'warn' as const }
            : {})}
        />
      </div>

      {/* CI outcome cost correlation */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">CI outcome vs cost</h2>
        {ci.cleanCount === 0 && ci.failedCount === 0 ? (
          <p className="text-sm text-text-3">No merged PRs with cost data in this window.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Clean-CI merges"
                value={ci.cleanAvgCost > 0 ? fmtUsd(ci.cleanAvgCost) : '—'}
                sub={`avg cost · ${ci.cleanCount} PRs`}
                accent="good"
              />
              <Stat
                label="CI-failed merges"
                value={ci.failedAvgCost > 0 ? fmtUsd(ci.failedAvgCost) : '—'}
                sub={`avg cost · ${ci.failedCount} PRs`}
                {...(ciCostMultiplier && ciCostMultiplier > 1 ? { accent: 'warn' as const } : {})}
              />
            </div>
            {ciCostMultiplier && ciCostMultiplier > 1 && (
              <p className="text-sm text-text-2">
                PRs that hit a failing check before merging cost{' '}
                <span className="font-semibold text-warn">{ciCostMultiplier.toFixed(1)}×</span> more
                agent spend on average than clean-CI merges.
              </p>
            )}
          </>
        )}
      </section>

      {/* Spend by Jira ticket */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">Spend by Jira ticket ({range}d)</h2>
        {jiraSpend.length === 0 ? (
          <p className="text-sm text-text-3">
            No PRs or sessions with a Jira key in this window. Jira keys are extracted from branch
            names, PR titles, and PR bodies.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-3 text-left">
                <th className="pb-2 font-medium">Ticket</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium text-right">PRs</th>
                <th className="pb-2 font-medium text-right">Merged</th>
                <th className="pb-2 font-medium text-right">Sessions</th>
                <th className="pb-2 font-medium text-right">Session spend</th>
                <th className="pb-2 font-medium text-right">PR spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {jiraSpend.map((j) => (
                <tr key={j.jiraKey}>
                  <td className="py-2">
                    <span className="font-mono text-xs">
                      <JiraLink jiraBase={jiraBase} jiraKey={j.jiraKey} />
                    </span>
                    {j.summary && (
                      <span className="ml-2 text-xs text-text-2">
                        {j.summary.length > 60 ? `${j.summary.slice(0, 60)}…` : j.summary}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-text-2">
                    {j.status ?? '—'}
                    {j.issueType ? ` · ${j.issueType}` : ''}
                  </td>
                  <td className="py-2 text-right text-text-2">{j.prCount}</td>
                  <td className="py-2 text-right text-text-2">{j.mergedPrs}</td>
                  <td className="py-2 text-right text-text-2">{j.sessionCount}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(j.sessionCostUsd)}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(j.totalCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-text-3">
          Session spend counts every session on the ticket's branch — including work that never
          reached a PR. PR spend is the rollup of sessions linked to the ticket's PRs. Ticket
          status/summary appear once the Jira sync job is configured.
        </p>
      </section>

      {/* Spend by project */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">Spend by Jira project ({range}d)</h2>
        {projectSpend.length === 0 ? (
          <p className="text-sm text-text-3">
            No tickets with a Jira key in this window. Project spend groups tickets by their key
            prefix (PLAT-123 → PLAT).
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-3 text-left">
                <th className="pb-2 font-medium">Project</th>
                <th className="pb-2 font-medium text-right">Tickets</th>
                <th className="pb-2 font-medium text-right">Merged PRs</th>
                <th className="pb-2 font-medium text-right">Session spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {projectSpend.map((p) => (
                <tr key={p.projectKey}>
                  <td className="py-2">
                    <span className="font-mono text-xs text-text">{p.projectKey}</span>
                    {p.projectName && (
                      <span className="ml-2 text-xs text-text-2">{p.projectName}</span>
                    )}
                  </td>
                  <td className="py-2 text-right text-text-2">{p.ticketCount}</td>
                  <td className="py-2 text-right text-text-2">{p.mergedPrs}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(p.sessionCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-text-3">
          Grouped by the ticket key's project prefix — works before the Jira sync has run; project
          display names appear once issues are synced.
        </p>
      </section>

      {/* Spend by epic */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">Spend by epic ({range}d)</h2>
        {epicSpend.length === 0 ? (
          <p className="text-sm text-text-3">
            No epic-level data. Epics require the Jira sync job (JIRA_BASE_URL + JIRA_API_TOKEN) to
            have resolved ticket metadata.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-3 text-left">
                <th className="pb-2 font-medium">Epic</th>
                <th className="pb-2 font-medium text-right">Tickets</th>
                <th className="pb-2 font-medium text-right">Merged PRs</th>
                <th className="pb-2 font-medium text-right">Session spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {epicSpend.map((e) => (
                <tr key={e.epicKey}>
                  <td className="py-2">
                    <span className="font-mono text-xs">
                      <JiraLink jiraBase={jiraBase} jiraKey={e.epicKey} />
                    </span>
                    {e.epicSummary && (
                      <span className="ml-2 text-xs text-text-2">
                        {e.epicSummary.length > 60
                          ? `${e.epicSummary.slice(0, 60)}…`
                          : e.epicSummary}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right text-text-2">{e.ticketCount}</td>
                  <td className="py-2 text-right text-text-2">{e.mergedPrs}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(e.sessionCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Cost per story point */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">Cost per story point ({range}d)</h2>
        {storyPoints.totalStoryPoints === 0 ? (
          <p className="text-sm text-text-3">
            No estimated tickets with agent spend in this window. Story points come from the Jira
            sync (JIRA_BASE_URL + JIRA_API_TOKEN); tickets without an estimate are excluded.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Stat
                label="Cost / story point"
                value={storyPoints.costPerPoint !== null ? fmtUsd(storyPoints.costPerPoint) : '—'}
                sub="agent spend ÷ estimated points"
              />
              <Stat
                label="Story points delivered"
                value={storyPoints.totalStoryPoints.toLocaleString()}
                sub={`${storyPoints.ticketCount} estimated tickets`}
              />
              <Stat
                label="Attributed spend"
                value={fmtUsd(storyPoints.sessionCostUsd)}
                sub="on estimated tickets"
              />
            </div>
            <p className="text-xs text-text-3">
              A defensible effort-normalized cost — unlike lines-of-code metrics, it uses the team's
              own sprint estimates. Only tickets carrying both a point estimate and agent spend
              count.
            </p>
          </>
        )}
      </section>

      {/* Business value delivered — real per-issue value (Jira value field) when
          available, else the flat story-point proxy (VALUE_PER_STORY_POINT).
          businessValue > 0 iff the proxy is configured (rate > 0) and points were
          delivered, so it stands in for the full proxy-availability check. */}
      {(hasRealValue || businessValue > 0) && (
        <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text-2">Business value delivered ({range}d)</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat
              label="Value delivered"
              value={fmtUsd(valueDeliveredUsd)}
              sub={
                hasRealValue
                  ? `${bizValue.ticketCount} tickets · Jira value field`
                  : `${storyPoints.totalStoryPoints.toLocaleString()} pts × ${fmtUsd(valuePerPoint ?? 0)}`
              }
            />
            <Stat
              label="Agent spend"
              value={fmtUsd(valueSpendUsd)}
              sub={hasRealValue ? 'on valued tickets' : 'on estimated tickets'}
            />
            <Stat
              label="Net value"
              value={fmtUsd(valueDeliveredUsd - valueSpendUsd)}
              sub="value − agent spend"
              {...(valueDeliveredUsd - valueSpendUsd >= 0
                ? { accent: 'good' as const }
                : { accent: 'crit' as const })}
            />
            <Stat
              label="Return multiple"
              value={valueSpendUsd > 0 ? `${valueReturnMultiple.toFixed(1)}×` : '—'}
              sub="value ÷ agent spend"
              {...(valueSpendUsd > 0
                ? { accent: valueReturnMultiple >= 1 ? ('good' as const) : ('warn' as const) }
                : {})}
            />
          </div>
          <p className="text-xs text-text-3">
            {hasRealValue ? (
              <>
                Value comes from the synced Jira value field (<code>JIRA_VALUE_FIELD</code>) — a
                true external join, summed per ticket over tickets that also had agent spend in this
                window.
              </>
            ) : (
              <>
                Value is delivered story points × the configured <code>VALUE_PER_STORY_POINT</code>{' '}
                rate ({fmtUsd(valuePerPoint ?? 0)}/pt) — a directional business-value proxy, only as
                good as your per-point valuation. Compares that against agent spend on the same
                estimated tickets.
              </>
            )}
          </p>
        </section>
      )}

      {/* Bug vs feature spend */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">Bug vs feature spend ({range}d)</h2>
        {classified.length === 0 ? (
          <p className="text-sm text-text-3">
            No classified tickets in this window. Issue types come from the Jira sync (JIRA_BASE_URL
            + JIRA_API_TOKEN).
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Bug-work spend"
                value={fmtUsd(bugSpend)}
                sub="sessions on Bug/Defect-type tickets"
                {...(bugShare !== null && bugShare > 0.3 ? { accent: 'warn' as const } : {})}
              />
              <Stat
                label="Bug-work share"
                value={bugShare !== null ? fmtPct(bugShare) : '—'}
                sub="of classified ticket spend"
              />
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-3 text-left">
                  <th className="pb-2 font-medium">Issue type</th>
                  <th className="pb-2 font-medium text-right">Tickets</th>
                  <th className="pb-2 font-medium text-right">Session spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {issueTypes.map((t) => (
                  <tr key={t.issueType}>
                    <td
                      className={`py-2 text-xs ${
                        BUG_ISSUE_TYPES.has(t.issueType.toLowerCase()) ? 'text-warn' : 'text-text'
                      }`}
                    >
                      {t.issueType}
                    </td>
                    <td className="py-2 text-right text-text-2">{t.ticketCount}</td>
                    <td className="py-2 text-right font-mono">{fmtUsd(t.sessionCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <p className="text-xs text-text-3">
          This measures agent spend on bug-type tickets — a rework signal — not which PR caused
          which defect. Unclassified rows are tickets the Jira sync hasn't resolved.
        </p>
      </section>

      {/* Merged-work provenance */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">Merged-work provenance ({range}d)</h2>
        <div className="grid grid-cols-2 gap-4">
          <Stat
            label="Agent-touched commits"
            value={String(commits.linkedCommits)}
            sub="default-branch commits attributed to a session"
          />
          <Stat
            label="Sessions with merged commits"
            value={String(commits.sessionsWithCommits)}
            sub="sessions whose work landed on the default branch"
          />
        </div>
        <p className="text-xs text-text-3">
          Attribution matches default-branch pushes to sessions by repo, author, and time window —
          it requires the code to have survived review, unlike lines-of-code metrics.
        </p>
      </section>

      {/* ROI by repo */}
      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-2">ROI by repo ({range}d)</h2>
        {repoRoi.length === 0 ? (
          <p className="text-sm text-text-3">No merged PR data available.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-3 text-left">
                <th className="pb-2 font-medium">Repo</th>
                <th className="pb-2 font-medium text-right">Merged</th>
                <th className="pb-2 font-medium text-right">Spend</th>
                <th className="pb-2 font-medium text-right">Cost / PR</th>
                <th className="pb-2 font-medium text-right">Revert rate</th>
                <th className="pb-2 font-medium text-right">CI-clean</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {repoRoi.map((r) => (
                <tr key={`${r.repoOwner}/${r.repoName}`}>
                  <td className="py-2 font-mono text-xs text-text">
                    {r.repoOwner}/{r.repoName}
                  </td>
                  <td className="py-2 text-right text-text-2">{r.mergedPrs}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(r.mergedSpendUsd)}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(r.costPerMergedPr)}</td>
                  <td
                    className={`py-2 text-right font-mono ${r.revertRate > HIGH_REVERT_RATE ? 'text-warn' : 'text-text-2'}`}
                  >
                    {fmtPct(r.revertRate)}
                  </td>
                  <td
                    className={`py-2 text-right font-mono ${r.ciCleanRate < LOW_CI_CLEAN_RATE ? 'text-warn' : 'text-text-2'}`}
                  >
                    {fmtPct(r.ciCleanRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-text-3 text-center pt-2">
        Spend is the agent cost rolled up to each PR from its contributing sessions. Reverted spend
        is cost that went into PRs later reverted — a rework signal, not necessarily waste.
      </p>
    </div>
  );
}
