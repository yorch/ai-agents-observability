import Link from 'next/link';
import { StatusBadge } from '@/components/me/StatusBadge';
import type { RecentSession } from '@/lib/me-queries';

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
  });
}

export function RecentSessions({ sessions }: { sessions: RecentSession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-xs text-text-3 uppercase tracking-widest mb-4">Recent Sessions</h2>
        <p className="text-sm text-text-3">No sessions yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs text-text-3 uppercase tracking-widest mb-4">Recent Sessions</h2>
      <div className="space-y-1">
        {sessions.map((s) => (
          <Link
            key={s.sessionId}
            href={`/me/sessions/${s.sessionId}`}
            className="flex items-center justify-between rounded-md border border-border-subtle px-3 py-2.5 hover:bg-surface-2 hover:border-border transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-text truncate">
                {s.repoName ?? 'Unknown repo'}
              </p>
              <p className="text-xs text-text-3 font-mono">{formatDate(s.startedAt)}</p>
            </div>
            <div className="flex items-center gap-3 ml-4 shrink-0">
              <span className="text-xs text-text-2 font-mono">
                {formatDuration(s.durationSeconds)}
              </span>
              <span className="text-xs text-text-2 font-mono">${s.costUsd.toFixed(3)}</span>
              <StatusBadge status={s.status} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
