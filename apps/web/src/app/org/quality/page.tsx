import { JiraLink } from '@/components/JiraLink';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
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
      <Card contentClassName="space-y-3">
        <h2 className="font-display text-sm font-semibold text-text">
          PR outcomes by session friction ({range}d)
        </h2>
        {totalPrs === 0 ? (
          <CardEmpty>
            No merged PRs with friction-scored contributing sessions in this period. Friction scores
            are computed nightly by the compute-effectiveness job.
          </CardEmpty>
        ) : (
          <Table
            columns={[
              { label: 'Contributing-session friction' },
              { align: 'right', label: 'Merged PRs' },
              { align: 'right', label: 'Revert rate' },
              { align: 'right', label: 'CI-failure rate' },
              { align: 'right', label: 'Bug-linked rate' },
              { align: 'right', label: 'Avg cost / PR' },
            ]}
          >
            {bands.map((b) => {
              const smallSample = b.mergedPrs < MIN_SAMPLE;
              const rateCls = smallSample ? 'text-text-3' : 'text-text';
              const rateCell = (outcome: BandOutcomeKey, count: number) => {
                const p = pValues.get(`${b.band}:${outcome}`);
                const significant = p !== undefined && p < SIGNIFICANCE_ALPHA;
                return (
                  <Cell num className={`align-top ${rateCls}`}>
                    {fmtPct(count / b.mergedPrs)}
                    {significant && <span className="text-warn">*</span>}
                    {p !== undefined && (
                      <span
                        className={`block text-[10px] ${significant ? 'text-warn' : 'text-text-3'}`}
                      >
                        {fmtPValue(p)}
                      </span>
                    )}
                  </Cell>
                );
              };
              return (
                <Row key={b.band}>
                  <Cell className="align-top text-text">
                    {BAND_LABELS[b.band]}
                    {smallSample && <span className="ml-2 text-xs text-text-3">small sample</span>}
                  </Cell>
                  <Cell num className="align-top text-text-2">
                    {b.mergedPrs}
                  </Cell>
                  {rateCell('reverted', b.reverted)}
                  {rateCell('ciFailed', b.ciFailed)}
                  {rateCell('bugLinked', b.bugLinked)}
                  <Cell num className={`align-top ${rateCls}`}>
                    {b.avgCostUsd > 0 ? fmtUsd(b.avgCostUsd) : '—'}
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
        <p className="text-xs text-text-3">
          Merged PRs bucketed by the mean friction score of their contributing sessions (same
          thresholds as the session friction bands). Association, not causation — bands under{' '}
          {MIN_SAMPLE} PRs are muted. Bug-linked requires the Jira sync; revert and CI rates work
          without it.
          {pValues.size > 0 && (
            <>
              {' '}
              Medium/high rates show the two-tailed Fisher&apos;s-exact p-value vs the low-friction
              band; <span className="text-warn">*</span> marks p &lt; {SIGNIFICANCE_ALPHA}. Avg cost
              is not tested (no variance data).
            </>
          )}
        </p>
      </Card>

      {/* Defect attribution */}
      <Card contentClassName="space-y-3">
        <h2 className="font-display text-sm font-semibold text-text">
          Bugs linked to tracked work ({range}d)
        </h2>
        {defects.length === 0 ? (
          <p className="text-sm text-text-3">
            No Bug-type issues linked to tracked tickets. Attribution needs the Jira sync
            (JIRA_BASE_URL + JIRA_API_TOKEN) and Jira issue links between bugs and the work that
            introduced them.
          </p>
        ) : (
          <Table
            columns={[
              { label: 'Bug' },
              { label: 'Link' },
              { label: 'Origin ticket' },
              { align: 'right', label: 'Origin merged PRs' },
              { align: 'right', label: 'Origin spend' },
              { align: 'right', label: 'Bug created' },
            ]}
          >
            {defects.map((d) => (
              <Row key={`${d.bugKey}-${d.originKey}-${d.linkPhrase ?? ''}`}>
                <Cell>
                  <span className="font-mono text-xs">
                    <JiraLink jiraBase={jiraBase} jiraKey={d.bugKey} />
                  </span>
                  {d.bugSummary && (
                    <span className="ml-2 text-xs text-text-2">
                      {d.bugSummary.length > 50 ? `${d.bugSummary.slice(0, 50)}…` : d.bugSummary}
                    </span>
                  )}
                  {d.bugStatus && <span className="ml-2 text-xs text-text-3">{d.bugStatus}</span>}
                </Cell>
                <Cell className="text-xs text-text-2">{d.linkPhrase ?? 'linked'}</Cell>
                <Cell className="text-xs">
                  <JiraLink jiraBase={jiraBase} jiraKey={d.originKey} />
                </Cell>
                <Cell num className="text-text-2">
                  {d.originMergedPrs}
                </Cell>
                <Cell num>{fmtUsd(d.originSpendUsd)}</Cell>
                <Cell num className="text-xs text-text-2">
                  {fmtDate(d.bugCreatedAt)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="text-xs text-text-3">
          A bug appears here when a Jira issue link connects it (either direction) to a ticket whose
          PRs we track. The link phrase is shown verbatim — "is caused by" carries more weight than
          "relates to". This reports linkage; causation is a human judgement.
        </p>
      </Card>
    </div>
  );
}
