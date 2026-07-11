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
  getSessionOrgContext,
  getSessionSkills,
  getSessionToolBreakdown,
} from '@/lib/sessions-queries';
import { getMemberForTeamByUserId, resolveTeamVisibility } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string; slug: string };
type SearchParams = { tab?: string };

export default async function TeamSessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const { id, slug } = await params;
  const { teamId, user } = await requireTeamLead(slug);

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    notFound();
  }

  const { visibleIds } = await resolveTeamVisibility(teamId);
  if (!visibleIds.includes(ctx.ownerUserId)) {
    notFound();
  }

  const member = await getMemberForTeamByUserId(teamId, ctx.ownerUserId);
  if (!member) {
    notFound();
  }

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

  const ownerName =
    member.displayName ?? (member.githubLogin ? `@${member.githubLogin}` : 'Unknown user');

  return (
    <div className="space-y-6">
      <Link
        href={`/team/${slug}/sessions`}
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white"
      >
        <ArrowLeftIcon /> Sessions
      </Link>

      <SessionDetailHeader
        ownerLabel={ownerName}
        session={session}
        transcriptHref={
          session.transcriptS3Key && member.canViewTranscripts
            ? `/team/${slug}/member/${member.githubLogin}/sessions/${id}/transcript`
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
