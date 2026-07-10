import { JiraLink } from '@/components/JiraLink';
import { PageHeader } from '@/components/team-org/PageHeader';
import { getJiraBase } from '@/lib/config';
import { fmtDate, fmtPct, fmtUsd } from '@/lib/fmt';
import { getDefectAttributions, getOutcomesByFrictionBand } from '@/lib/quality-queries';
import { requireOrgViewer } from '@/lib/roles';
import type { BandOutcomeKey } from '@/lib/stats';
import { compareBandsToBaseline, fmtPValue } from '@/lib/stats';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// Below this many merged PRs a band's rates say very little — show them muted
// with the sample size, never as a confident number.
const MIN_SAMPLE = 10;

// Two-tailed Fisher's exact p-value below which a band's rate is marked as
// significantly different from the low-friction baseline.
const SIGNIFICANCE_ALPHA = 0.05;

const BAND_LABELS: Record<string, string> = {
  high: 'High friction',
  low: 'Low friction',
  medium: 'Medium friction',
};

export default async function OrgQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 90) as 7 | 30 | 90;
  const since = daysAgo(range);

  const [bands, defects] = await Promise.all([
    getOutcomesByFrictionBand(since),
    getDefectAttributions(since),
  ]);
  const jiraBase = getJiraBase();

  const totalPrs = bands.reduce((sum, b) => sum + b.mergedPrs, 0);

  // Fisher's exact p-values for each medium/high rate vs the low baseline —
  // exact at any n, so small bands honestly come back "not significant".
  const pValues = new Map(
    compareBandsToBaseline(bands).map((c) => [`${c.band}:${c.outcome}`, c.pValue]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Session characteristics joined to PR outcomes · trailing ${range} days`}
        range={range}
        title="Quality"
      />

      {/* Outcome rates by friction band */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">
          PR outcomes by session friction ({range}d)
        </h2>
        {totalPrs === 0 ? (
          <p className="text-sm text-white/40">
            No merged PRs with friction-scored contributing sessions in this window. Friction scores
            are computed nightly by the compute-effectiveness job.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Contributing-session friction</th>
                <th className="pb-2 font-medium text-right">Merged PRs</th>
                <th className="pb-2 font-medium text-right">Revert rate</th>
                <th className="pb-2 font-medium text-right">CI-failure rate</th>
                <th className="pb-2 font-medium text-right">Bug-linked rate</th>
                <th className="pb-2 font-medium text-right">Avg cost / PR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {bands.map((b) => {
                const smallSample = b.mergedPrs < MIN_SAMPLE;
                const rateCls = smallSample ? 'text-white/30' : 'text-white/80';
                const rateCell = (outcome: BandOutcomeKey, count: number) => {
                  const p = pValues.get(`${b.band}:${outcome}`);
                  return (
                    <td
                      className={`py-2 text-right font-mono ${rateCls}`}
                      title={
                        p === undefined
                          ? undefined
                          : `${fmtPValue(p)} vs low band (two-tailed Fisher's exact)`
                      }
                    >
                      {fmtPct(count / b.mergedPrs)}
                      {p !== undefined && p < SIGNIFICANCE_ALPHA && (
                        <span className="text-amber-400">*</span>
                      )}
                    </td>
                  );
                };
                return (
                  <tr key={b.band}>
                    <td className="py-2 text-white/80">
                      {BAND_LABELS[b.band]}
                      {smallSample && (
                        <span className="ml-2 text-xs text-white/30">small sample</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-white/60">{b.mergedPrs}</td>
                    {rateCell('reverted', b.reverted)}
                    {rateCell('ciFailed', b.ciFailed)}
                    {rateCell('bugLinked', b.bugLinked)}
                    <td className={`py-2 text-right font-mono ${rateCls}`}>
                      {b.avgCostUsd > 0 ? fmtUsd(b.avgCostUsd) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-xs text-white/30">
          Merged PRs bucketed by the mean friction score of their contributing sessions (same
          thresholds as the session friction bands). Association, not causation — bands under{' '}
          {MIN_SAMPLE} PRs are muted. Bug-linked requires the Jira sync; revert and CI rates work
          without it.
          {pValues.size > 0 && (
            <>
              {' '}
              Hover a medium/high rate for its two-tailed Fisher&apos;s-exact p-value vs the low
              band; <span className="text-amber-400">*</span> marks p &lt; {SIGNIFICANCE_ALPHA}. Avg
              cost is not tested (no variance data).
            </>
          )}
        </p>
      </section>

      {/* Defect attribution */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">
          Bugs linked to tracked work ({range}d)
        </h2>
        {defects.length === 0 ? (
          <p className="text-sm text-white/40">
            No Bug-type issues linked to tracked tickets. Attribution needs the Jira sync
            (JIRA_BASE_URL + JIRA_API_TOKEN) and Jira issue links between bugs and the work that
            introduced them.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Bug</th>
                <th className="pb-2 font-medium">Link</th>
                <th className="pb-2 font-medium">Origin ticket</th>
                <th className="pb-2 font-medium text-right">Origin merged PRs</th>
                <th className="pb-2 font-medium text-right">Origin spend</th>
                <th className="pb-2 font-medium text-right">Bug created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {defects.map((d) => (
                <tr key={`${d.bugKey}-${d.originKey}-${d.linkPhrase ?? ''}`}>
                  <td className="py-2">
                    <span className="font-mono text-xs">
                      <JiraLink jiraBase={jiraBase} jiraKey={d.bugKey} />
                    </span>
                    {d.bugSummary && (
                      <span className="ml-2 text-xs text-white/50">
                        {d.bugSummary.length > 50 ? `${d.bugSummary.slice(0, 50)}…` : d.bugSummary}
                      </span>
                    )}
                    {d.bugStatus && (
                      <span className="ml-2 text-xs text-white/30">{d.bugStatus}</span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-white/50">{d.linkPhrase ?? 'linked'}</td>
                  <td className="py-2 font-mono text-xs">
                    <JiraLink jiraBase={jiraBase} jiraKey={d.originKey} />
                  </td>
                  <td className="py-2 text-right text-white/60">{d.originMergedPrs}</td>
                  <td className="py-2 text-right font-mono">{fmtUsd(d.originSpendUsd)}</td>
                  <td className="py-2 text-right text-xs text-white/50">
                    {fmtDate(d.bugCreatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-white/30">
          A bug appears here when a Jira issue link connects it (either direction) to a ticket whose
          PRs we track. The link phrase is shown verbatim — "is caused by" carries more weight than
          "relates to". This reports linkage; causation is a human judgement.
        </p>
      </section>
    </div>
  );
}
