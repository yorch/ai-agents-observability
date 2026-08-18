import Link from 'next/link';
import { JiraLink } from '@/components/JiraLink';
import { StatusBadge } from '@/components/me/StatusBadge';
import { Cell, EmptyState, Pagination, Row, Table, TONE_TEXT } from '@/components/ui';
import { computeFrictionScore, frictionBadge } from '@/lib/effectiveness';
import { fmtDateTime, fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import { SESSIONS_PAGE_SIZE, type SessionRow } from '@/lib/sessions-queries';
import { ShapeBadge } from './shape';

type SessionsTableProps = {
  basePath?: string;
  currentPage: number;
  /** Builds the pager href for a page, preserving any active filters. */
  hrefFor?: (page: number) => string;
  // Jira browse base URL (NEXT_PUBLIC_JIRA_BASE_URL); keys render as plain text when unset.
  jiraBase?: string | null;
  sessions: SessionRow[];
  total: number;
};

export function SessionsTable({
  sessions,
  total,
  currentPage,
  basePath = '/me/sessions',
  hrefFor = (page) => `?page=${page}`,
  jiraBase = null,
}: SessionsTableProps) {
  if (sessions.length === 0) {
    return <EmptyState>No sessions found</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <Table
        columns={[
          { label: 'Started (UTC)' },
          { label: 'Repo' },
          { label: 'Ticket' },
          { label: 'Shape' },
          { align: 'right', label: 'Duration' },
          { align: 'right', label: 'Events' },
          { align: 'right', label: 'Cost' },
          { label: 'Friction' },
          { label: 'Status' },
        ]}
      >
        {sessions.map((s) => {
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
                <Link
                  href={`${basePath}/${s.sessionId}`}
                  className="hover:text-accent transition-colors"
                >
                  {fmtDateTime(s.startedAt)}
                </Link>
              </Cell>
              <Cell className="text-text-2 max-w-[200px] truncate">{s.repoName ?? '—'}</Cell>
              <Cell className="text-xs">
                {s.jiraKey ? (
                  <JiraLink
                    jiraBase={jiraBase}
                    jiraKey={s.jiraKey}
                    className="text-accent hover:opacity-80 transition-opacity"
                    plainClassName="text-text-2"
                  />
                ) : (
                  <span className="text-text-3">—</span>
                )}
              </Cell>
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

      <Pagination
        page={currentPage}
        pageSize={SESSIONS_PAGE_SIZE}
        total={total}
        hrefFor={hrefFor}
      />
    </div>
  );
}
