import Link from 'next/link';
import type { SessionRow } from '../../lib/sessions-queries';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    abandoned: 'bg-yellow-500/20 text-yellow-400',
    active: 'bg-green-500/20 text-green-400',
    completed: 'bg-blue-500/20 text-blue-400',
    crashed: 'bg-red-500/20 text-red-400',
    timed_out: 'bg-orange-500/20 text-orange-400',
  };
  const color = colors[status] ?? 'bg-white/10 text-white/50';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}

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
  currentPage: number;
  sessions: SessionRow[];
  total: number;
};

const PAGE_SIZE = 50;

export function SessionsTable({ sessions, total, currentPage }: SessionsTableProps) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm text-white/50">No sessions found</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-white/40 text-xs">
              <th className="text-left px-4 py-3">Started</th>
              <th className="text-left px-4 py-3">Repo</th>
              <th className="text-right px-4 py-3">Duration</th>
              <th className="text-right px-4 py-3">Events</th>
              <th className="text-right px-4 py-3">Cost</th>
              <th className="text-center px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.sessionId}
                className="border-b border-white/5 hover:bg-white/5 transition-colors"
              >
                <td className="px-4 py-3 text-white/70">
                  <Link href={`/me/sessions/${s.sessionId}`} className="hover:text-white">
                    {formatDate(s.startedAt)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-white/70 max-w-[200px] truncate">
                  {s.repoName ?? '—'}
                </td>
                <td className="px-4 py-3 text-right text-white/60">
                  {formatDuration(s.durationSeconds)}
                </td>
                <td className="px-4 py-3 text-right text-white/60">{s.eventCount}</td>
                <td className="px-4 py-3 text-right text-white/60">${s.costUsd.toFixed(3)}</td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={s.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-white/40">
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} of{' '}
            {total}
          </p>
          <div className="flex gap-2">
            {hasPrev && (
              <a
                href={`?page=${currentPage - 1}`}
                className="rounded-md border border-white/10 px-3 py-1.5 hover:bg-white/10 transition-colors"
              >
                ← Prev
              </a>
            )}
            {hasNext && (
              <a
                href={`?page=${currentPage + 1}`}
                className="rounded-md border border-white/10 px-3 py-1.5 hover:bg-white/10 transition-colors"
              >
                Next →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
