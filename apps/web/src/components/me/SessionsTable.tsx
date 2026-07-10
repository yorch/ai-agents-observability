import Link from 'next/link';
import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { JiraLink } from '@/components/JiraLink';
import { StatusBadge } from '@/components/me/StatusBadge';
import { computeFrictionScore, frictionBadge, shapeBadge } from '@/lib/effectiveness';
import type { SessionRow } from '@/lib/sessions-queries';

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
  const rem = m % 60;
  return `${h}h ${rem}m`;
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

type SessionsTableProps = {
  basePath?: string;
  currentPage: number;
  // Jira browse base URL (NEXT_PUBLIC_JIRA_BASE_URL); keys render as plain text when unset.
  jiraBase?: string | null;
  sessions: SessionRow[];
  total: number;
};

const PAGE_SIZE = 50;

export function SessionsTable({
  sessions,
  total,
  currentPage,
  basePath = '/me/sessions',
  jiraBase = null,
}: SessionsTableProps) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center">
        <p className="text-sm text-text-3">No sessions found</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-3 text-xs">
              <th className="text-left px-4 py-3">Started</th>
              <th className="text-left px-4 py-3">Repo</th>
              <th className="text-left px-4 py-3">Ticket</th>
              <th className="text-left px-4 py-3">Shape</th>
              <th className="text-right px-4 py-3">Duration</th>
              <th className="text-right px-4 py-3">Events</th>
              <th className="text-right px-4 py-3">Cost</th>
              <th className="text-center px-4 py-3">Friction</th>
              <th className="text-center px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
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
                <tr
                  key={s.sessionId}
                  className="border-b border-border-subtle hover:bg-surface transition-colors"
                >
                  <td className="px-4 py-3 text-text-2 font-mono text-xs">
                    <Link
                      href={`${basePath}/${s.sessionId}`}
                      className="hover:text-accent transition-colors"
                    >
                      {formatDate(s.startedAt)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-text-2 max-w-[200px] truncate">
                    {s.repoName ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
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
                  </td>
                  <td className="px-4 py-3">
                    {s.shapeLabel ? (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${shapeBadge(s.shapeLabel as Parameters<typeof shapeBadge>[0])}`}
                      >
                        {s.shapeLabel}
                      </span>
                    ) : (
                      <span className="text-text-3 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-text-2 font-mono text-xs">
                    {formatDuration(s.durationSeconds)}
                  </td>
                  <td className="px-4 py-3 text-right text-text-2 font-mono text-xs">
                    {s.eventCount}
                  </td>
                  <td className="px-4 py-3 text-right text-text-2 font-mono text-xs">
                    ${s.costUsd.toFixed(3)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {badge ? (
                      <span
                        className={`text-xs font-medium font-mono ${badge.color}`}
                        title={`${((friction ?? 0) * 100).toFixed(0)}%`}
                      >
                        {badge.label}
                      </span>
                    ) : (
                      <span className="text-text-3 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={s.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-text-3 font-mono text-xs">
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} of{' '}
            {total}
          </p>
          <div className="flex gap-2">
            {hasPrev && (
              <a
                href={`?page=${currentPage - 1}`}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-text-2 hover:border-accent hover:text-accent transition-colors"
              >
                <ArrowLeftIcon /> Prev
              </a>
            )}
            {hasNext && (
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
