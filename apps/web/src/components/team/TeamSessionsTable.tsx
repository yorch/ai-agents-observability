import Link from 'next/link';
import { StatusBadge } from '@/components/me/StatusBadge';
import { ShapeBadge } from '@/components/me/shape';
import { ButtonLink, Cell, EmptyState, Pagination, Row, Table, TONE_TEXT } from '@/components/ui';
import { computeFrictionScore, frictionBadge } from '@/lib/effectiveness';
import { fmtDateTime, fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import { TEAM_PAGE_SIZE, type TeamSessionRow } from '@/lib/team-queries';

export function TeamSessionsTable({
  currentPage,
  hrefFor = (page) => `?page=${page}`,
  sessions,
  slug,
  total,
}: {
  currentPage: number;
  /** Builds the pager href for a page, preserving any active filters. */
  hrefFor?: (page: number) => string;
  sessions: TeamSessionRow[];
  slug: string;
  total: number;
}) {
  if (sessions.length === 0) {
    // An out-of-range page (stale bookmark, a filter that shrank the result set
    // under your feet) is not "no sessions" — saying so leaves the reader on an
    // empty view whose only explanation is the URL. /me/sessions already
    // distinguishes these; this list did not.
    if (total > 0) {
      return (
        <EmptyState
          title="Nothing on this page"
          action={
            <ButtonLink variant="secondary" href={hrefFor(1)}>
              Back to page 1
            </ButtonLink>
          }
        >
          These sessions start on an earlier page.
        </EmptyState>
      );
    }
    return <EmptyState>No sessions found</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <Table
        columns={[
          { label: 'Member' },
          { label: 'Started (UTC)' },
          { label: 'Repo' },
          { label: 'Shape' },
          { align: 'right', label: 'Duration' },
          { align: 'right', label: 'Events' },
          { align: 'right', label: 'Cost' },
          { label: 'Friction' },
          { label: 'Status' },
        ]}
      >
        {sessions.map((s) => {
          const login = s.ownerLogin;
          const sessionPath = `/team/${slug}/sessions/${s.sessionId}`;
          const friction =
            s.frictionScore ??
            computeFrictionScore({
              durationSeconds: s.durationSeconds,
              interruptCount: 0,
              permissionDenyCount: 0,
              status: s.status,
              toolCallCount: s.eventCount,
              toolErrorCount: 0,
              userMessageCount: 0,
            });
          const badge = friction !== null ? frictionBadge(friction) : null;
          return (
            <Row key={s.sessionId}>
              <Cell className="text-text-2 text-xs">
                {login ? (
                  <Link
                    href={`/team/${slug}/member/${login}`}
                    className="hover:text-accent transition-colors"
                  >
                    {s.ownerDisplayName ?? `@${login}`}
                  </Link>
                ) : (
                  <span className="text-text-3">—</span>
                )}
              </Cell>
              <Cell className="text-text-2 text-xs">
                <Link href={sessionPath} className="hover:text-accent transition-colors">
                  {fmtDateTime(s.startedAt)}
                </Link>
              </Cell>
              <Cell className="text-text-2 max-w-[180px] truncate">{s.repoName ?? '—'}</Cell>
              <Cell>
                <ShapeBadge label={s.shapeLabel} />
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {fmtDurationSec(s.durationSeconds)}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {s.eventCount}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {fmtUsdSession(s.costUsd)}
              </Cell>
              <Cell className="text-center">
                {badge ? (
                  <span
                    className={`text-xs font-medium font-mono ${TONE_TEXT[badge.tone]}`}
                    title={`${((friction ?? 0) * 100).toFixed(0)}%`}
                  >
                    {badge.label}
                  </span>
                ) : (
                  <span className="text-text-3 text-xs">—</span>
                )}
              </Cell>
              <Cell className="text-center">
                <StatusBadge status={s.status} />
              </Cell>
            </Row>
          );
        })}
      </Table>

      <Pagination page={currentPage} pageSize={TEAM_PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </div>
  );
}
