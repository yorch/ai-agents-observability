import Link from 'next/link';
import { StatusBadge } from '@/components/me/StatusBadge';
import { Card } from '@/components/ui';
import { fmtDateTime, fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import type { RecentSession } from '@/lib/me-queries';

export function RecentSessions({ sessions }: { sessions: RecentSession[] }) {
  if (sessions.length === 0) {
    return (
      <Card>
        <h2 className="mb-4 font-mono text-[10px] uppercase tracking-widest text-text-3">
          Recent Sessions
        </h2>
        <p className="text-sm text-text-3">No sessions yet</p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="mb-4 font-mono text-[10px] uppercase tracking-widest text-text-3">
        Recent Sessions (UTC)
      </h2>
      <div className="space-y-1">
        {sessions.map((s) => (
          <Link
            key={s.sessionId}
            href={`/me/sessions/${s.sessionId}`}
            className="flex min-w-0 items-center justify-between rounded-md border border-border-subtle px-3 py-2.5 hover:bg-surface-2 hover:border-border transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-text truncate">
                {s.repoName ?? 'Unknown repo'}
              </p>
              <p className="text-xs text-text-3 font-mono">{fmtDateTime(s.startedAt)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 ml-4 shrink-0">
              <span className="text-xs text-text-2 font-mono">
                {fmtDurationSec(s.durationSeconds)}
              </span>
              <span className="text-xs text-text-2 font-mono">{fmtUsdSession(s.costUsd)}</span>
              <StatusBadge status={s.status} />
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
