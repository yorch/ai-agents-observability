import Link from 'next/link';
import { StatusBadge } from '@/components/me/StatusBadge';
import type { SessionDetail } from '@/lib/sessions-queries';

/**
 * The session-detail header (repo + status + git/owner meta + cost + optional
 * transcript link). Shared by the /me, /team, and /org detail pages — they differ
 * only in the owner label, the transcript link target/label, and whether a
 * transcript link is shown at all, all passed as props. The audience-specific
 * back link stays in each page.
 */
export function SessionDetailHeader({
  ownerLabel,
  session,
  transcriptHref,
  transcriptLabel = 'View transcript',
}: {
  ownerLabel?: string;
  session: SessionDetail;
  transcriptHref?: string | null;
  transcriptLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{session.repoName ?? 'Unknown repo'}</h1>
          <StatusBadge status={session.status} />
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-white/50">
          {ownerLabel && <span>{ownerLabel}</span>}
          {session.branch && <span>branch: {session.branch}</span>}
          {session.commitSha && <span>commit: {session.commitSha.slice(0, 7)}</span>}
          <span>started: {session.startedAt.toLocaleString()}</span>
          {session.endedAt && <span>ended: {session.endedAt.toLocaleString()}</span>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-white/70">${session.costUsd.toFixed(4)}</span>
        {transcriptHref && (
          <Link
            href={transcriptHref}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 transition-colors"
          >
            {transcriptLabel}
          </Link>
        )}
      </div>
    </div>
  );
}
