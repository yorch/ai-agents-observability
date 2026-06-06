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
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-medium text-white/70 mb-4">Recent Sessions</h2>
        <p className="text-sm text-white/40">No sessions yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h2 className="text-sm font-medium text-white/70 mb-4">Recent Sessions</h2>
      <div className="space-y-2">
        {sessions.map((s) => (
          <Link
            key={s.sessionId}
            href={`/me/sessions/${s.sessionId}`}
            className="flex items-center justify-between rounded-md border border-white/5 bg-white/5 px-3 py-2 hover:bg-white/10 transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{s.repoName ?? 'Unknown repo'}</p>
              <p className="text-xs text-white/40">{formatDate(s.startedAt)}</p>
            </div>
            <div className="flex items-center gap-3 ml-4 shrink-0">
              <span className="text-xs text-white/50">{formatDuration(s.durationSeconds)}</span>
              <span className="text-xs text-white/50">${s.costUsd.toFixed(3)}</span>
              <StatusBadge status={s.status} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
