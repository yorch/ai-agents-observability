import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { resolveOrgSessionAccess } from '@/lib/roles';
import type {
  ModelBreakdownRow,
  SessionSkillRow,
  SessionSubagentRow,
  SessionToolRow,
} from '@/lib/sessions-queries';
import {
  getSession,
  getSessionEvents,
  getSessionModelBreakdown,
  getSessionOrgContext,
  getSessionSkills,
  getSessionToolBreakdown,
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
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    notFound();
  }

  // org_admin (standing) OR investigator with an active grant (§8.4). Everyone
  // else 404s — viewer_aggregate must never reach an individual session.
  const access = await resolveOrgSessionAccess(user, {
    ownerUserId: ctx.ownerUserId,
    sessionId: id,
  });
  if (!access) {
    notFound();
  }

  // §8.3: every privileged view of another user's session is audited.
  void writeAuditLog({
    action: AuditAction.VIEW_SESSION,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: ctx.ownerUserId,
  });

  const { tab = 'timeline' } = await searchParams;

  const noTools = { subagents: [] as SessionSubagentRow[], tools: [] as SessionToolRow[] };
  const [session, modelBreakdown, sessionEvents, skillRows, toolBreakdown] = await Promise.all([
    getSession(ctx.ownerUserId, id),
    tab === 'models'
      ? getSessionModelBreakdown(ctx.ownerUserId, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(ctx.ownerUserId, id) : Promise.resolve([]),
    tab === 'skills'
      ? getSessionSkills(ctx.ownerUserId, id)
      : Promise.resolve([] as SessionSkillRow[]),
    tab === 'tools' ? getSessionToolBreakdown(ctx.ownerUserId, id) : Promise.resolve(noTools),
  ]);
  if (!session) {
    notFound();
  }

  const owner = ctx.displayName ?? (ctx.ownerLogin ? `@${ctx.ownerLogin}` : 'Unknown user');

  return (
    <div className="space-y-6">
      <Link
        href="/org/search"
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white"
      >
        <ArrowLeftIcon /> Search
      </Link>

      <SessionDetailHeader
        ownerLabel={owner}
        session={session}
        transcriptHref={session.transcriptS3Key ? `/org/sessions/${id}/transcript` : null}
        transcriptLabel={
          access === 'grant' || ctx.shareTranscriptsWithOrg
            ? 'View transcript'
            : 'Request transcript access'
        }
      />

      <SessionDetailTabs
        events={sessionEvents}
        modelBreakdown={modelBreakdown}
        session={session}
        skillRows={skillRows}
        subagentRows={toolBreakdown.subagents}
        tab={tab}
        toolRows={toolBreakdown.tools}
      />
    </div>
  );
}
