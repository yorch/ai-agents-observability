import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { requireTeamLead } from '@/lib/roles';
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
  getSessionSkills,
  getSessionToolBreakdown,
} from '@/lib/sessions-queries';
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
    action: AuditAction.VIEW_SESSION,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: member.userId,
  });

  const { tab = 'timeline' } = await searchParams;

  const noTools = { subagents: [] as SessionSubagentRow[], tools: [] as SessionToolRow[] };
  const [session, modelBreakdown, sessionEvents, skillRows, toolBreakdown] = await Promise.all([
    getSession(member.userId, id),
    tab === 'models'
      ? getSessionModelBreakdown(member.userId, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(member.userId, id) : Promise.resolve([]),
    tab === 'skills'
      ? getSessionSkills(member.userId, id)
      : Promise.resolve([] as SessionSkillRow[]),
    tab === 'tools' ? getSessionToolBreakdown(member.userId, id) : Promise.resolve(noTools),
  ]);
  if (!session) {
    notFound();
  }

  const displayName = member.displayName ?? `@${member.githubLogin}`;

  return (
    <div className="space-y-6">
      <Link
        href={`/team/${slug}/member/${login}`}
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white"
      >
        <ArrowLeftIcon /> {displayName}
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
        skillRows={skillRows}
        subagentRows={toolBreakdown.subagents}
        tab={tab}
        toolRows={toolBreakdown.tools}
      />
    </div>
  );
}
