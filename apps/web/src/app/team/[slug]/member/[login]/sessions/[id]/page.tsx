import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { StatusBadge } from '@/components/me/StatusBadge';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { requireTeamLead } from '@/lib/roles';
import type { ModelBreakdownRow } from '@/lib/sessions-queries';
import { getSession, getSessionEvents, getSessionModelBreakdown } from '@/lib/sessions-queries';
import { getMemberForTeam } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string; login: string; slug: string };
type SearchParams = { tab?: string };

export default async function TeamMemberSessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const { id, login, slug } = await params;
  const { teamId, user } = await requireTeamLead(slug);

  const member = await getMemberForTeam(teamId, login);
  if (!member?.canViewStats) {
    notFound();
  }

  // P3-005: fire-and-forget audit written before data is returned.
  void writeAuditLog({
    action: AuditAction.view_session,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: member.userId,
  });

  const { tab = 'timeline' } = await searchParams;

  const [session, modelBreakdown, sessionEvents] = await Promise.all([
    getSession(member.userId, id),
    tab === 'models'
      ? getSessionModelBreakdown(member.userId, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(member.userId, id) : Promise.resolve([]),
  ]);
  if (!session) {
    notFound();
  }

  const displayName = member.displayName ?? `@${member.githubLogin}`;

  return (
    <div className="space-y-6">
      <Link
        href={`/team/${slug}/member/${login}`}
        className="text-sm text-white/50 hover:text-white"
      >
        ← {displayName}
      </Link>

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
          {session.transcriptS3Key && member.canViewTranscripts && (
            <Link
              href={`/team/${slug}/member/${login}/sessions/${id}/transcript`}
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
