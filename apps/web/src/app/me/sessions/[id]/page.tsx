import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
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
      <SessionDetailHeader
        session={session}
        transcriptHref={session.transcriptS3Key ? `/me/sessions/${id}/transcript` : null}
      />

      <SessionDetailTabs
        events={sessionEvents}
        modelBreakdown={modelBreakdown}
        session={session}
        tab={tab}
      />
    </div>
  );
}
