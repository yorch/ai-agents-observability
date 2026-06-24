import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
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

      <SessionDetailHeader
        session={session}
        transcriptHref={
          session.transcriptS3Key && member.canViewTranscripts
            ? `/team/${slug}/member/${login}/sessions/${id}/transcript`
            : null
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
