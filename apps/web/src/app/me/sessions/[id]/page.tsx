import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { StatusBadge } from '@/components/me/StatusBadge';
import { currentUser } from '@/lib/auth';
import type { ModelBreakdownRow } from '@/lib/sessions-queries';
import { getSession, getSessionEvents, getSessionModelBreakdown } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };
type SearchParams = { tab?: string };

export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const { id } = await params;
  const { tab = 'timeline' } = await searchParams;

  // The breakdown only needs userId+sessionId (not the session row), so when the
  // models tab is active run both queries concurrently instead of serially.
  const [session, modelBreakdown, sessionEvents] = await Promise.all([
    getSession(user.id, id),
    tab === 'models'
      ? getSessionModelBreakdown(user.id, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(user.id, id) : Promise.resolve([]),
  ]);
  if (!session) {
    notFound();
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/me/sessions" className="text-sm text-white/50 hover:text-white">
        ← Sessions
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{session.repoName ?? 'Unknown repo'}</h1>
            <StatusBadge status={session.status} />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-white/50">
            {session.branch && <span>branch: {session.branch}</span>}
            {session.commitSha && <span>commit: {session.commitSha.slice(0, 7)}</span>}
            <span>started: {session.startedAt.toLocaleString()}</span>
            {session.endedAt && <span>ended: {session.endedAt.toLocaleString()}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-white/70">${session.costUsd.toFixed(4)}</span>
          {session.transcriptS3Key && (
            <Link
              href={`/me/sessions/${id}/transcript`}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 transition-colors"
            >
              View transcript
            </Link>
          )}
        </div>
      </div>

      <SessionDetailTabs
        events={sessionEvents}
        modelBreakdown={modelBreakdown}
        session={session}
        tab={tab}
      />
    </div>
  );
}
