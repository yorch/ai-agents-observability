import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
import { frictionBadge } from '@/lib/effectiveness';
import { fmtDateTime, fmtUsd, fmtUsdOrDash, fmtUsdSession } from '@/lib/fmt';
import { type SessionSearchResult, searchSessions } from '@/lib/org-queries';
import { canViewIndividuals, requireOrgViewer } from '@/lib/roles';
import { diffToolMix, getSessionComparison, metricDelta } from '@/lib/session-compare-queries';

export const dynamic = 'force-dynamic';

type SearchParams = { left?: string | string[]; right?: string | string[] };

// UUID validation — reject malformed IDs early rather than letting them reach
// the DB and throw on the ::uuid cast.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramToId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return null;
  }
  return value;
}

export default async function SessionComparePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { left: leftRaw, right: rightRaw } = await searchParams;
  const leftId = paramToId(leftRaw);
  const rightId = paramToId(rightRaw);

  // Until both sides are chosen, the page is its own picker. It used to render
  // an empty state telling the reader to hand-edit the query string, which —
  // combined with there being no link to this route anywhere in the app — meant
  // a finished feature nobody could reach.
  if (!leftId || !rightId) {
    const { orgRole } = await requireOrgViewer();
    const recent = await searchSessions({ page: 1 }, canViewIndividuals(orgRole));
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumb="Org"
          description="Choose two sessions to compare side-by-side"
          title="Session comparison"
        />
        <SessionPicker leftId={leftId} recent={recent.results.slice(0, 25)} rightId={rightId} />
      </div>
    );
  }

  const comparison = await getSessionComparison(leftId, rightId);

  if ('error' in comparison) {
    // Map both 404 and 403 to notFound() to avoid creating an existence/access
    // oracle — an attacker must not be able to distinguish "session does not
    // exist" from "session exists but you cannot see it" by swapping left/right.
    if (comparison.status === 404 || comparison.status === 403) {
      notFound();
    }
    return (
      <div className="space-y-6">
        <PageHeader breadcrumb="Org" description="" title="Session comparison" />
        <EmptyState>{comparison.error}</EmptyState>
      </div>
    );
  }

  const { left, right } = comparison;
  const costDelta = metricDelta(left.detail.costUsd, right.detail.costUsd);
  const durationDelta = metricDelta(left.detail.durationSeconds, right.detail.durationSeconds);
  const frictionDelta = metricDelta(left.detail.frictionScore, right.detail.frictionScore);
  const toolCallDelta = metricDelta(left.detail.toolCallCount, right.detail.toolCallCount);
  const toolErrorDelta = metricDelta(left.detail.toolErrorCount, right.detail.toolErrorCount);
  const tokenDelta = metricDelta(
    Number(left.detail.inputTokens + left.detail.outputTokens),
    Number(right.detail.inputTokens + right.detail.outputTokens),
  );

  const toolDiff = diffToolMix(left.tools, right.tools);

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumb="Org"
        description="Side-by-side comparison of two sessions — tool mix, cost, friction, and outcome"
        title="Session comparison"
      />

      {/* Session links */}
      <div className="flex gap-4 text-sm">
        <Link
          className="text-text-2 hover:text-text underline-offset-2 hover:underline"
          href={`/org/sessions/${leftId}`}
        >
          ← Left session
        </Link>
        <Link
          className="text-text-2 hover:text-text underline-offset-2 hover:underline"
          href={`/org/sessions/${rightId}`}
        >
          Right session →
        </Link>
      </div>

      {/* Summary comparison cards */}
      <div className="grid grid-cols-3 gap-4">
        <ComparisonStat
          label="Cost"
          leftValue={fmtUsd(left.detail.costUsd)}
          rightValue={fmtUsd(right.detail.costUsd)}
          delta={costDelta.delta}
          formatDelta={(d) => fmtUsdOrDash(d)}
        />
        <ComparisonStat
          label="Duration"
          leftValue={
            left.detail.durationSeconds ? formatDuration(left.detail.durationSeconds) : '—'
          }
          rightValue={
            right.detail.durationSeconds ? formatDuration(right.detail.durationSeconds) : '—'
          }
          delta={durationDelta.delta}
          formatDelta={(d) => (d !== null ? formatDuration(d) : '—')}
        />
        <ComparisonStat
          label="Friction"
          leftValue={
            left.detail.frictionScore !== null
              ? `${left.detail.frictionScore.toFixed(2)} (${frictionBadge(left.detail.frictionScore).label})`
              : '—'
          }
          rightValue={
            right.detail.frictionScore !== null
              ? `${right.detail.frictionScore.toFixed(2)} (${frictionBadge(right.detail.frictionScore).label})`
              : '—'
          }
          delta={frictionDelta.delta}
          formatDelta={(d) => (d !== null ? d.toFixed(2) : '—')}
        />
        <ComparisonStat
          label="Tool calls"
          leftValue={left.detail.toolCallCount.toLocaleString()}
          rightValue={right.detail.toolCallCount.toLocaleString()}
          delta={toolCallDelta.delta}
          formatDelta={(d) => (d !== null ? d.toLocaleString() : '—')}
        />
        <ComparisonStat
          label="Tool errors"
          leftValue={left.detail.toolErrorCount.toLocaleString()}
          rightValue={right.detail.toolErrorCount.toLocaleString()}
          delta={toolErrorDelta.delta}
          formatDelta={(d) => (d !== null ? d.toLocaleString() : '—')}
        />
        <ComparisonStat
          label="Total tokens"
          leftValue={Number(left.detail.inputTokens + left.detail.outputTokens).toLocaleString()}
          rightValue={Number(right.detail.inputTokens + right.detail.outputTokens).toLocaleString()}
          delta={tokenDelta.delta}
          formatDelta={(d) => (d !== null ? d.toLocaleString() : '—')}
        />
      </div>

      {/* Metadata comparison */}
      <div className="space-y-3">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
          Session metadata
        </h2>
        <Table columns={[{ label: 'Field' }, { label: 'Left' }, { label: 'Right' }]}>
          <MetadataRow field="Status" left={left.detail.status} right={right.detail.status} />
          <MetadataRow
            field="Model"
            left={left.detail.primaryModel ?? '—'}
            right={right.detail.primaryModel ?? '—'}
          />
          <MetadataRow
            field="Shape"
            left={left.detail.shapeLabel ?? '—'}
            right={right.detail.shapeLabel ?? '—'}
          />
          <MetadataRow
            field="Repo"
            left={left.detail.repoName ?? '—'}
            right={right.detail.repoName ?? '—'}
          />
          <MetadataRow
            field="Branch"
            left={left.detail.branch ?? '—'}
            right={right.detail.branch ?? '—'}
          />
          <MetadataRow
            field="Interrupts"
            left={String(left.detail.interruptCount)}
            right={String(right.detail.interruptCount)}
          />
          <MetadataRow
            field="Compactions"
            left={String(left.detail.compactionCount)}
            right={String(right.detail.compactionCount)}
          />
          <MetadataRow
            field="User messages"
            left={String(left.detail.userMessageCount)}
            right={String(right.detail.userMessageCount)}
          />
        </Table>
      </div>

      {/* Outcome comparison */}
      <div className="space-y-3">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">PR outcome</h2>
        <Table columns={[{ label: 'Field' }, { label: 'Left' }, { label: 'Right' }]}>
          <MetadataRow
            field="PR number"
            left={left.outcome.prNumber ? `#${left.outcome.prNumber}` : '—'}
            right={right.outcome.prNumber ? `#${right.outcome.prNumber}` : '—'}
          />
          <MetadataRow
            field="PR state"
            left={left.outcome.prState ?? '—'}
            right={right.outcome.prState ?? '—'}
          />
          <MetadataRow
            field="CI status"
            left={left.outcome.prCiStatus ?? '—'}
            right={right.outcome.prCiStatus ?? '—'}
          />
          <MetadataRow
            field="Review decision"
            left={left.outcome.prReviewDecision ?? '—'}
            right={right.outcome.prReviewDecision ?? '—'}
          />
          <MetadataRow
            field="Merged"
            left={
              left.outcome.prMergedAt ? left.outcome.prMergedAt.toISOString().slice(0, 10) : '—'
            }
            right={
              right.outcome.prMergedAt ? right.outcome.prMergedAt.toISOString().slice(0, 10) : '—'
            }
          />
          <MetadataRow
            field="Reverted"
            left={
              left.outcome.prRevertedAt ? left.outcome.prRevertedAt.toISOString().slice(0, 10) : '—'
            }
            right={
              right.outcome.prRevertedAt
                ? right.outcome.prRevertedAt.toISOString().slice(0, 10)
                : '—'
            }
          />
        </Table>
      </div>

      {/* Tool mix diff */}
      <div className="space-y-3">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
          Tool mix comparison
        </h2>
        {toolDiff.length === 0 ? (
          <EmptyState>No tool calls in either session.</EmptyState>
        ) : (
          <Table
            columns={[
              { label: 'Tool' },
              { label: 'Category' },
              { align: 'right', label: 'Left calls' },
              { align: 'right', label: 'Left errors' },
              { align: 'right', label: 'Right calls' },
              { align: 'right', label: 'Right errors' },
              { align: 'right', label: 'Δ calls' },
            ]}
          >
            {toolDiff.map((row) => {
              const callDelta = row.rightCalls - row.leftCalls;
              return (
                <Row key={row.toolName}>
                  <Cell className="text-text">{row.toolName}</Cell>
                  <Cell className="text-text-2">{row.toolCategory ?? '—'}</Cell>
                  <Cell num className="text-text-2">
                    {row.leftCalls.toLocaleString()}
                  </Cell>
                  <Cell num className="text-text-2">
                    {row.leftErrors.toLocaleString()}
                  </Cell>
                  <Cell num className="text-text-2">
                    {row.rightCalls.toLocaleString()}
                  </Cell>
                  <Cell num className="text-text-2">
                    {row.rightErrors.toLocaleString()}
                  </Cell>
                  <Cell
                    num
                    className={
                      callDelta > 0 ? 'text-warn' : callDelta < 0 ? 'text-good' : 'text-text-3'
                    }
                  >
                    {callDelta > 0 ? '+' : ''}
                    {callDelta !== 0 ? callDelta.toLocaleString() : '—'}
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }
  if (seconds >= 60) {
    return `${(seconds / 60).toFixed(1)}m`;
  }
  return `${seconds}s`;
}

function ComparisonStat({
  label,
  leftValue,
  rightValue,
  delta,
  formatDelta,
}: {
  label: string;
  leftValue: string;
  rightValue: string;
  delta: number | null;
  formatDelta: (d: number | null) => string;
}) {
  const deltaStr = delta !== null && delta !== 0 ? formatDelta(delta) : '—';
  const deltaClass =
    delta === null
      ? 'text-text-3'
      : delta > 0
        ? 'text-warn'
        : delta < 0
          ? 'text-good'
          : 'text-text-3';
  const sign = delta !== null && delta > 0 ? '+' : '';
  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-text-3">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] text-text-3">Left</p>
          <p className="text-sm font-mono font-medium text-text">{leftValue}</p>
        </div>
        <div>
          <p className="text-[10px] text-text-3">Right</p>
          <p className="text-sm font-mono font-medium text-text">{rightValue}</p>
        </div>
      </div>
      <p className={`text-xs font-mono ${deltaClass}`}>
        Δ {sign}
        {deltaStr}
      </p>
    </div>
  );
}

function MetadataRow({ field, left, right }: { field: string; left: string; right: string }) {
  const same = left === right;
  return (
    <Row>
      <Cell className="text-text-2 text-sm">{field}</Cell>
      <Cell className={`text-sm ${same ? 'text-text-2' : 'text-text'}`}>{left}</Cell>
      <Cell className={`text-sm ${same ? 'text-text-2' : 'text-text'}`}>{right}</Cell>
    </Row>
  );
}

/**
 * Two-slot picker. Choosing one side keeps the other, so the flow is "pick A,
 * pick B, land on the comparison" without ever touching the URL by hand.
 */
function SessionPicker({
  leftId,
  recent,
  rightId,
}: {
  leftId: string | null;
  recent: SessionSearchResult[];
  rightId: string | null;
}) {
  if (recent.length === 0) {
    return (
      <EmptyState title="No sessions available to compare.">
        Sessions appear here once org members have shared telemetry.
      </EmptyState>
    );
  }

  const slotHref = (slot: 'left' | 'right', id: string) => {
    const query = new URLSearchParams();
    const other = slot === 'left' ? rightId : leftId;
    query.set(slot, id);
    if (other) {
      query.set(slot === 'left' ? 'right' : 'left', other);
    }
    return `?${query.toString()}`;
  };

  return (
    <>
      <p className="text-sm text-text-2">
        {leftId
          ? 'Session A is chosen — pick session B to see the comparison.'
          : 'Pick session A, then session B.'}
      </p>
      <Table
        columns={[
          { label: 'Started (UTC)' },
          { label: 'Developer' },
          { label: 'Repo' },
          { align: 'right', label: 'Tools' },
          { align: 'right', label: 'Cost' },
          { label: 'Compare as' },
        ]}
      >
        {recent.map((session) => {
          const isLeft = session.sessionId === leftId;
          const isRight = session.sessionId === rightId;
          return (
            <Row key={session.sessionId}>
              <Cell className="text-xs text-text-2">{fmtDateTime(session.startedAt)}</Cell>
              <Cell className="text-xs text-text-2">{session.githubLogin ?? '—'}</Cell>
              <Cell className="text-xs text-text-2">{session.repoName ?? '—'}</Cell>
              <Cell num className="text-xs text-text-2">
                {session.toolCallCount.toLocaleString()}
              </Cell>
              <Cell num className="text-xs text-text-2">
                {fmtUsdSession(session.costUsd)}
              </Cell>
              <Cell>
                <span className="flex gap-2 text-xs">
                  {isLeft ? (
                    <span className="text-accent">A ✓</span>
                  ) : (
                    <Link
                      className="text-accent hover:underline"
                      href={slotHref('left', session.sessionId)}
                    >
                      A
                    </Link>
                  )}
                  {isRight ? (
                    <span className="text-accent">B ✓</span>
                  ) : (
                    <Link
                      className="text-accent hover:underline"
                      href={slotHref('right', session.sessionId)}
                    >
                      B
                    </Link>
                  )}
                </span>
              </Cell>
            </Row>
          );
        })}
      </Table>
    </>
  );
}
