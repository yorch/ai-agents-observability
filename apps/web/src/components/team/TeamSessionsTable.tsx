import Link from 'next/link';
import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { StatusBadge } from '@/components/me/StatusBadge';
import { ShapeBadge } from '@/components/me/shape';
import { Cell, EmptyState, Row, Table, TONE_TEXT } from '@/components/ui';
import { computeFrictionScore, frictionBadge } from '@/lib/effectiveness';
import type { TeamSessionRow } from '@/lib/team-queries';

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) {
    return `${m}m ${s}s`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${Math.floor(m % 60)}m`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const PAGE_SIZE = 50;

export function TeamSessionsTable({
  currentPage,
  sessions,
  slug,
  total,
}: {
  currentPage: number;
  sessions: TeamSessionRow[];
  slug: string;
  total: number;
}) {
  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (sessions.length === 0) {
    return <EmptyState>No sessions found</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <Table
        columns={[
          { label: 'Member' },
          { label: 'Started' },
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
                  {formatDate(s.startedAt)}
                </Link>
              </Cell>
              <Cell className="text-text-2 max-w-[180px] truncate">{s.repoName ?? '—'}</Cell>
              <Cell>
                <ShapeBadge label={s.shapeLabel} />
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {formatDuration(s.durationSeconds)}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {s.eventCount}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                ${s.costUsd.toFixed(3)}
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-text-3 font-mono text-xs">
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} of{' '}
            {total}
          </p>
          <div className="flex gap-2">
            {currentPage > 1 && (
              <a
                href={`?page=${currentPage - 1}`}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-text-2 hover:border-accent hover:text-accent transition-colors"
              >
                <ArrowLeftIcon /> Prev
              </a>
            )}
            {currentPage < totalPages && (
              <a
                href={`?page=${currentPage + 1}`}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-text-2 hover:border-accent hover:text-accent transition-colors"
              >
                Next <ArrowRightIcon />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
