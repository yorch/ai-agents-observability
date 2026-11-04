import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from '@/components/icons';
import { StatusBadge } from '@/components/me/StatusBadge';
import { PageHeader } from '@/components/team-org/PageHeader';
import { buttonClasses, Cell, cx, EmptyState, Row, SectionHeader, Table } from '@/components/ui';
import { frictionBadge } from '@/lib/effectiveness';
import { fmtDate, fmtDateTime, fmtDurationSec, fmtFriction, fmtUsdSession } from '@/lib/fmt';
import { type SessionSearchResult, searchSessions } from '@/lib/org-queries';
import { canViewIndividuals, requireOrgViewer } from '@/lib/roles';
import {
  type ComparePickSummary,
  diffToolMix,
  getComparePickSummary,
  getSessionComparison,
  metricDelta,
} from '@/lib/session-compare-queries';

/** "+x" / "−x" / "" around an unsigned formatter — never "$-0.00". */
function signed(d: number, fmt: (abs: number) => string): string {
  return `${d > 0 ? '+' : d < 0 ? '\u2212' : ''}${fmt(Math.abs(d))}`;
}

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
    // The picker renders only an empty state when there is nothing to pick, so
    // the pick summaries (an access-checked, audited lookup) would go unseen.
    const hasSessions = recent.results.length > 0;
    const [leftPick, rightPick] = await Promise.all([
      leftId && hasSessions ? getComparePickSummary(leftId) : Promise.resolve(null),
      rightId && hasSessions ? getComparePickSummary(rightId) : Promise.resolve(null),
    ]);
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumb="Org"
          description="Choose two sessions to compare side-by-side"
          title="Compare sessions"
        />
        <SessionPicker
          leftId={leftId}
          leftPick={leftPick}
          recent={recent.results.slice(0, 25)}
          rightId={rightId}
          rightPick={rightPick}
        />
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
        <PageHeader breadcrumb="Org" description="" title="Compare sessions" />
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
        title="Compare sessions"
      />

      {/* Session links */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link
          className="inline-flex items-center gap-1 text-text-2 hover:text-text underline-offset-2 hover:underline"
          href={`/org/sessions/${leftId}`}
        >
          <ArrowLeftIcon size={12} /> Session A
        </Link>
        <Link
          className="inline-flex items-center gap-1 text-text-2 hover:text-text underline-offset-2 hover:underline"
          href={`/org/sessions/${rightId}`}
        >
          Session B <ArrowRightIcon size={12} />
        </Link>
      </div>

      {/* Summary comparison cards. Only cost and friction are judged (lower is
          better); a count delta is a difference, not a verdict. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ComparisonStat
          judge
          label="Cost"
          leftValue={fmtUsdSession(left.detail.costUsd)}
          rightValue={fmtUsdSession(right.detail.costUsd)}
          delta={costDelta.delta}
          formatDelta={(d) => signed(d, fmtUsdSession)}
        />
        <ComparisonStat
          label="Duration"
          leftValue={fmtDurationSec(left.detail.durationSeconds)}
          rightValue={fmtDurationSec(right.detail.durationSeconds)}
          delta={durationDelta.delta}
          formatDelta={(d) => signed(d, fmtDurationSec)}
        />
        <ComparisonStat
          judge
          label="Friction"
          leftValue={
            left.detail.frictionScore !== null
              ? `${fmtFriction(left.detail.frictionScore)} (${frictionBadge(left.detail.frictionScore).label})`
              : '—'
          }
          rightValue={
            right.detail.frictionScore !== null
              ? `${fmtFriction(right.detail.frictionScore)} (${frictionBadge(right.detail.frictionScore).label})`
              : '—'
          }
          delta={frictionDelta.delta}
          formatDelta={(d) => signed(d, fmtFriction)}
        />
        <ComparisonStat
          label="Tool calls"
          leftValue={left.detail.toolCallCount.toLocaleString()}
          rightValue={right.detail.toolCallCount.toLocaleString()}
          delta={toolCallDelta.delta}
          formatDelta={(d) => signed(d, (n) => n.toLocaleString())}
        />
        <ComparisonStat
          label="Tool errors"
          leftValue={left.detail.toolErrorCount.toLocaleString()}
          rightValue={right.detail.toolErrorCount.toLocaleString()}
          delta={toolErrorDelta.delta}
          formatDelta={(d) => signed(d, (n) => n.toLocaleString())}
        />
        <ComparisonStat
          label="Total tokens"
          leftValue={Number(left.detail.inputTokens + left.detail.outputTokens).toLocaleString()}
          rightValue={Number(right.detail.inputTokens + right.detail.outputTokens).toLocaleString()}
          delta={tokenDelta.delta}
          formatDelta={(d) => signed(d, (n) => n.toLocaleString())}
        />
      </div>

      {/* Metadata comparison */}
      <div className="space-y-3">
        <SectionHeader>Session metadata</SectionHeader>
        <Table columns={[{ label: 'Field' }, { label: 'A' }, { label: 'B' }]}>
          <MetadataRow
            field="Status"
            left={<StatusBadge status={left.detail.status} />}
            right={<StatusBadge status={right.detail.status} />}
            same={left.detail.status === right.detail.status}
          />
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
        <SectionHeader>PR outcome</SectionHeader>
        <Table columns={[{ label: 'Field' }, { label: 'A' }, { label: 'B' }]}>
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
            left={fmtDate(left.outcome.prMergedAt)}
            right={fmtDate(right.outcome.prMergedAt)}
          />
          <MetadataRow
            field="Reverted"
            left={fmtDate(left.outcome.prRevertedAt)}
            right={fmtDate(right.outcome.prRevertedAt)}
          />
        </Table>
      </div>

      {/* Tool mix diff */}
      <div className="space-y-3">
        <SectionHeader>Tool mix comparison</SectionHeader>
        {toolDiff.length === 0 ? (
          <EmptyState>No tool calls in either session.</EmptyState>
        ) : (
          <Table
            columns={[
              { label: 'Tool' },
              { label: 'Category' },
              { align: 'right', label: 'A calls' },
              { align: 'right', label: 'A errors' },
              { align: 'right', label: 'B calls' },
              { align: 'right', label: 'B errors' },
              { align: 'right', label: 'B − A calls' },
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
                  <Cell num className="text-text-3">
                    {callDelta !== 0 ? signed(callDelta, (n) => n.toLocaleString()) : '—'}
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

function ComparisonStat({
  judge = false,
  label,
  leftValue,
  rightValue,
  delta,
  formatDelta,
}: {
  /** Colour the delta as better/worse. Only for lower-is-better metrics. */
  judge?: boolean;
  label: string;
  leftValue: string;
  rightValue: string;
  delta: number | null;
  /** Formats a non-zero delta, sign included. */
  formatDelta: (d: number) => string;
}) {
  const deltaStr = delta !== null && delta !== 0 ? formatDelta(delta) : '—';
  const deltaClass =
    judge && delta !== null && delta !== 0
      ? delta > 0
        ? 'text-warn'
        : 'text-good'
      : 'text-text-3';
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-4 space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-text-3">{label}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <p className="text-[10px] text-text-3">A</p>
          <p className="text-sm font-mono font-medium text-text [overflow-wrap:anywhere]">
            {leftValue}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] text-text-3">B</p>
          <p className="text-sm font-mono font-medium text-text [overflow-wrap:anywhere]">
            {rightValue}
          </p>
        </div>
      </div>
      <p className={cx('text-xs font-mono', deltaClass)}>
        <span className="text-text-3">B − A</span> {deltaStr}
      </p>
    </div>
  );
}

function MetadataRow({
  field,
  left,
  right,
  same = left === right,
}: {
  field: string;
  left: ReactNode;
  right: ReactNode;
  same?: boolean;
}) {
  return (
    <Row>
      <Cell className="text-text-2 text-sm">{field}</Cell>
      <Cell className={cx('text-sm', same ? 'text-text-2' : 'text-text')}>{left}</Cell>
      <Cell className={cx('text-sm', same ? 'text-text-2' : 'text-text')}>{right}</Cell>
    </Row>
  );
}

function PickSummary({
  id,
  pick,
  slot,
}: {
  id: string;
  pick: ComparePickSummary | null;
  slot: 'A' | 'B';
}) {
  return (
    <p className="text-sm text-text-2">
      <span className="font-mono text-xs text-text-3">Session {slot}:</span>{' '}
      {pick ? (
        <Link className="hover:text-text hover:underline" href={`/org/sessions/${id}`}>
          {pick.repoName ?? 'Unknown repo'} · {pick.ownerLabel} · {fmtDateTime(pick.startedAt)} UTC
        </Link>
      ) : (
        <span className="text-text-3">not found or not visible to you</span>
      )}
    </p>
  );
}

/**
 * Two-slot picker. Choosing one side keeps the other, so the flow is "pick A,
 * pick B, land on the comparison" without ever touching the URL by hand.
 */
function SessionPicker({
  leftId,
  leftPick,
  recent,
  rightId,
  rightPick,
}: {
  leftId: string | null;
  leftPick: ComparePickSummary | null;
  recent: SessionSearchResult[];
  rightId: string | null;
  rightPick: ComparePickSummary | null;
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
      <div className="space-y-1">
        <p className="text-sm text-text-2">
          {leftId
            ? 'Session A is chosen — pick session B to see the comparison.'
            : rightId
              ? 'Session B is chosen — pick session A to see the comparison.'
              : 'Pick session A, then session B.'}
        </p>
        {leftId && <PickSummary id={leftId} pick={leftPick} slot="A" />}
        {rightId && <PickSummary id={rightId} pick={rightPick} slot="B" />}
      </div>
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
              <Cell className="text-xs text-text-2">
                {session.githubLogin ?? session.displayName ?? '—'}
              </Cell>
              <Cell className="text-xs text-text-2">{session.repoName ?? '—'}</Cell>
              <Cell num className="text-xs text-text-2">
                {session.toolCallCount.toLocaleString()}
              </Cell>
              <Cell num className="text-xs text-text-2">
                {fmtUsdSession(session.costUsd)}
              </Cell>
              <Cell>
                <span className="flex gap-2">
                  {isLeft ? (
                    <span className="relative inline-flex items-center gap-1 px-2 text-xs text-accent">
                      A <CheckIcon size={12} />
                      <span className="sr-only">(chosen)</span>
                    </span>
                  ) : (
                    <Link
                      aria-label="Compare as session A"
                      className={buttonClasses('secondary', 'sm')}
                      href={slotHref('left', session.sessionId)}
                    >
                      A
                    </Link>
                  )}
                  {isRight ? (
                    <span className="relative inline-flex items-center gap-1 px-2 text-xs text-accent">
                      B <CheckIcon size={12} />
                      <span className="sr-only">(chosen)</span>
                    </span>
                  ) : (
                    <Link
                      aria-label="Compare as session B"
                      className={buttonClasses('secondary', 'sm')}
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
