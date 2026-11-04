import Link from 'next/link';
import { StatusBadge } from '@/components/me/StatusBadge';
import { Card, CardEmpty } from '@/components/ui';
import { fmtDateTime, fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import type { RecentSession } from '@/lib/me-queries';

export function RecentSessions({ sessions }: { sessions: RecentSession[] }) {
  const viewAll = (
    <Link href="/me/sessions" className="text-accent hover:underline">
      View all
    </Link>
  );

  if (sessions.length === 0) {
    return (
      <Card title="Recent sessions" caption="Times in UTC">
        <CardEmpty>No sessions recorded yet.</CardEmpty>
      </Card>
    );
  }

  return (
    <Card title="Recent sessions" caption="Times in UTC" hint={viewAll}>
      <div className="space-y-1">
        {sessions.map((s) => (
          <Link
            key={s.sessionId}
            href={`/me/sessions/${s.sessionId}`}
            className="flex flex-col gap-1 rounded-md border border-border-subtle px-3 py-2.5 transition-colors hover:border-border hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text">
                {s.repoName ?? 'Unknown repo'}
              </p>
              <p className="whitespace-nowrap font-mono text-xs text-text-3">
                {fmtDateTime(s.startedAt)}
              </p>
            </div>
            <div className="flex items-center gap-3 sm:ml-4 sm:shrink-0">
              <span className="font-mono text-xs text-text-2">
                {fmtDurationSec(s.durationSeconds)}
              </span>
              <span className="font-mono text-xs text-text-2">{fmtUsdSession(s.costUsd)}</span>
              <StatusBadge status={s.status} />
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
