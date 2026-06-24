import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { requireOrgAdmin } from '@/lib/roles';
import type { ModelBreakdownRow } from '@/lib/sessions-queries';
import {
  getSession,
  getSessionEvents,
  getSessionModelBreakdown,
  getSessionOrgContext,
} from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };
type SearchParams = { tab?: string };

export default async function OrgSessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  // Org-admin only — viewer_aggregate must never reach an individual session.
  const { user } = await requireOrgAdmin();

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    notFound();
  }

  // §8.3: every org-admin view of another user's session is audited.
  void writeAuditLog({
    action: AuditAction.view_session,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: ctx.ownerUserId,
  });

  const { tab = 'timeline' } = await searchParams;

  const [session, modelBreakdown, sessionEvents] = await Promise.all([
    getSession(ctx.ownerUserId, id),
    tab === 'models'
      ? getSessionModelBreakdown(ctx.ownerUserId, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(ctx.ownerUserId, id) : Promise.resolve([]),
  ]);
  if (!session) {
    notFound();
  }

  const owner = ctx.displayName ?? (ctx.ownerLogin ? `@${ctx.ownerLogin}` : 'Unknown user');

  return (
    <div className="space-y-6">
      <Link href="/org/search" className="text-sm text-white/50 hover:text-white">
        ← Search
      </Link>

      <SessionDetailHeader
        ownerLabel={owner}
        session={session}
        transcriptHref={session.transcriptS3Key ? `/org/sessions/${id}/transcript` : null}
        transcriptLabel={
          ctx.shareTranscriptsWithOrg ? 'View transcript' : 'Request transcript access'
        }
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
