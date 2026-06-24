import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TranscriptPanel } from '@/components/me/TranscriptPanel';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { requireTeamLead } from '@/lib/roles';
import { getSession } from '@/lib/sessions-queries';
import { getMemberForTeam } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string; login: string; slug: string };

export default async function TeamMemberTranscriptPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { id, login, slug } = await params;
  const { teamId, user } = await requireTeamLead(slug);

  const member = await getMemberForTeam(teamId, login);
  if (!member?.canViewStats) {
    notFound();
  }

  const session = await getSession(member.userId, id);
  if (!session) {
    notFound();
  }

  if (!member.canViewTranscripts) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link
            href={`/team/${slug}/member/${login}/sessions/${id}`}
            className="text-sm text-white/50 hover:text-white"
          >
            ← Session
          </Link>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm text-white/50">
            This member has not shared transcripts with the team.
          </p>
        </div>
      </div>
    );
  }

  // P3-005: fire-and-forget audit — never throws, errors logged to stderr.
  void writeAuditLog({
    action: AuditAction.VIEW_TRANSCRIPT,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: member.userId,
  });

  const apiUrl = `/api/team/${slug}/member/${login}/transcripts/${id}`;

  return (
    <TranscriptPanel
      apiUrl={apiUrl}
      backHref={`/team/${slug}/member/${login}/sessions/${id}`}
      hasTranscript={Boolean(session.transcriptS3Key)}
      sessionId={id}
      subtitle={`${session.repoName ?? 'Unknown repo'} · ${session.startedAt.toLocaleString()}`}
    />
  );
}
