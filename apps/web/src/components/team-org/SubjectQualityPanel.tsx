import { Badge, Card, Cell, Row, Table } from '@/components/ui';
import { fmtPValue } from '@/lib/stats';
import type { DeprecationCandidate, SubjectQualityRow } from '@/lib/subject-quality-queries';
import {
  compareSubjectOutcomes,
  SUBJECT_MIN_CALLS,
  SUBJECT_MIN_SESSIONS_PER_ARM,
  SUBJECT_SIGNIFICANCE_ALPHA,
  subjectErrorRate,
} from '@/lib/subject-quality-queries';

/**
 * The shared quality panel for skills and MCP servers (P13-004).
 *
 * One component serves `/org/skills`, `/org/mcp` and both team equivalents, so
 * the caveats below cannot be present on one page and missing on another —
 * which is how a hedged comparison turns into a verdict.
 *
 * Three things are deliberate in the rendering:
 *
 * - Every rate carries its sample size, in the same cell.
 * - A comparison below the volume gate renders the words "not yet measurable"
 *   rather than a greyed-out number. A number the reader is asked to discount
 *   still anchors them.
 * - Nothing is sorted by quality and nothing is badged good/bad. The table is
 *   ordered by invocation volume, which is a fact, not a judgement.
 */

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function frictionCell(arm: { medianFriction: number | null; sessionCount: number }): string {
  if (arm.sessionCount < SUBJECT_MIN_SESSIONS_PER_ARM || arm.medianFriction === null) {
    return '—';
  }
  return arm.medianFriction.toFixed(2);
}

const OUTCOME_LABEL: Record<'reverted' | 'ciFailed', string> = {
  ciFailed: 'CI failure',
  reverted: 'revert',
};

export function SubjectQualityPanel({
  caption,
  rows,
  subjectNoun,
  title,
}: {
  caption: string;
  rows: SubjectQualityRow[];
  /** "skill" or "MCP server" — drives the copy, never a hardcoded agent name. */
  subjectNoun: string;
  title: string;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <Card caption={caption} flush title={title}>
      <div className="px-4 pb-4">
        <Table
          columns={[
            { label: subjectNoun },
            { align: 'right', label: 'Invocations', mono: true },
            { align: 'right', label: 'Users', mono: true },
            { align: 'right', label: 'Downstream errors', mono: true },
            { align: 'right', label: 'Median friction (with)', mono: true },
            { align: 'right', label: 'Median friction (matched)', mono: true },
            { label: 'Outcome comparison' },
          ]}
        >
          {rows.map((r) => {
            const comparisons = compareSubjectOutcomes(r);
            const errorRate = subjectErrorRate(r);
            return (
              <Row key={`${r.kind}:${r.name}`}>
                <Cell>
                  <span className="font-mono text-text">{r.name}</span>
                  {r.kind !== 'mcp_server' && (
                    <span className="ml-2 text-xs capitalize text-text-3">{r.kind}</span>
                  )}
                </Cell>
                <Cell num className="text-text-2">
                  {r.invocations.toLocaleString()}
                </Cell>
                <Cell num className="text-text-2">
                  {r.distinctUsers}
                </Cell>
                <Cell num className="text-text-2">
                  {errorRate === null ? (
                    <span className="text-text-3">under {SUBJECT_MIN_CALLS} calls</span>
                  ) : (
                    <>
                      {pct(errorRate)}
                      <span className="ml-1 text-xs text-text-3">
                        / {r.downstreamCalls.toLocaleString()}
                      </span>
                    </>
                  )}
                </Cell>
                <Cell num className="text-text-2">
                  {frictionCell(r.with)}
                  <span className="ml-1 text-xs text-text-3">n={r.with.sessionCount}</span>
                </Cell>
                <Cell num className="text-text-2">
                  {frictionCell(r.without)}
                  <span className="ml-1 text-xs text-text-3">n={r.without.sessionCount}</span>
                </Cell>
                <Cell>
                  <div className="flex flex-wrap gap-1.5">
                    {comparisons.map((c) =>
                      c.measurable && c.pValue !== null ? (
                        <Badge
                          key={c.outcome}
                          tone={c.pValue < SUBJECT_SIGNIFICANCE_ALPHA ? 'accent' : 'neutral'}
                        >
                          {OUTCOME_LABEL[c.outcome]} {pct(c.rateWith)} vs {pct(c.rateWithout)} ·{' '}
                          {fmtPValue(c.pValue)}
                        </Badge>
                      ) : (
                        <Badge key={c.outcome} tone="neutral">
                          {OUTCOME_LABEL[c.outcome]} not yet measurable
                        </Badge>
                      ),
                    )}
                  </div>
                </Cell>
              </Row>
            );
          })}
        </Table>

        <p className="mt-3 text-xs text-text-3">
          Association, not causation. The comparison pool for each {subjectNoun.toLowerCase()} is
          restricted to sessions of the same shape, so a {subjectNoun.toLowerCase()} used mostly on
          debugging work is compared against debugging sessions — but shape is a partial control
          only. Task difficulty, repository and self-selection all survive it, and a{' '}
          {subjectNoun.toLowerCase()} reached for on hard problems will look worse than one reached
          for on easy ones. Read a difference here as a place to go and look, never as a verdict on
          the {subjectNoun.toLowerCase()}.
        </p>
        <p className="mt-2 text-xs text-text-3">
          Comparisons need at least {SUBJECT_MIN_SESSIONS_PER_ARM} sessions on each side and error
          rates at least {SUBJECT_MIN_CALLS} calls; below that they read &ldquo;not yet
          measurable&rdquo; rather than reporting an underpowered number. Significance is a
          two-tailed Fisher&rsquo;s exact test at &alpha;&nbsp;=&nbsp;{SUBJECT_SIGNIFICANCE_ALPHA}.
          &ldquo;Downstream errors&rdquo; counts failed tool calls made after the first invocation
          in the same session.
        </p>
      </div>
    </Card>
  );
}

/**
 * Zero-invocation subjects, reported rather than omitted (`OPPORTUNITIES.md`
 * §3.3). The platform observes; it never disables anything or recommends that
 * anyone else does.
 */
export function DeprecationCandidates({
  candidates,
  windowDays,
}: {
  candidates: DeprecationCandidate[];
  windowDays: number;
}) {
  if (candidates.length === 0) {
    return null;
  }
  return (
    <Card
      caption={`Used before this window, not once inside it. Reported, not acted on — whether to retire one is a human decision.`}
      flush
      title="Deprecation candidates"
    >
      <div className="px-4 pb-4">
        <Table
          columns={[
            { label: 'Name' },
            { label: 'Type' },
            { align: 'right', label: `Invocations before ${windowDays}d`, mono: true },
            { align: 'right', label: 'Last used' },
          ]}
        >
          {candidates.map((c) => (
            <Row key={`${c.kind}:${c.name}`}>
              <Cell>
                <span className="font-mono text-text">{c.name}</span>
              </Cell>
              <Cell className="text-xs capitalize text-text-3">{c.kind.replace('_', ' ')}</Cell>
              <Cell num className="text-text-2">
                {c.historicInvocations.toLocaleString()}
              </Cell>
              <Cell num className="text-text-2">
                {c.lastUsedAt.toISOString().slice(0, 10)}
              </Cell>
            </Row>
          ))}
        </Table>
      </div>
    </Card>
  );
}
