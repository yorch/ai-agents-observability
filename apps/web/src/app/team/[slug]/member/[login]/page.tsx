import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SessionsTable } from '../../../../../components/me/SessionsTable';
import { AuditAction, writeAuditLog } from '../../../../../lib/audit';
import { requireTeamLead } from '../../../../../lib/roles';
import { listSessions } from '../../../../../lib/sessions-queries';
import { getMemberForTeam } from '../../../../../lib/team-queries';

export const dynamic = 'force-dynamic';

type SearchParams = { page?: string };

export default async function TeamMemberSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ login: string; slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { login, slug } = await params;
  const { teamId, user } = await requireTeamLead(slug);

  const member = await getMemberForTeam(teamId, login);
  if (!member || !member.canViewStats) {
    notFound();
  }

  // P3-005: fire-and-forget audit — never throws, errors logged to stderr.
  void writeAuditLog({
    action: AuditAction.view_session,
    actorUserId: user.id,
    targetUserId: member.userId,
  });

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10));
  const { sessions, total } = await listSessions(member.userId, { page });

  const displayName = member.displayName ?? `@${member.githubLogin}`;
  const basePath = `/team/${slug}/member/${login}/sessions`;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/team/${slug}/roster`} className="text-sm text-white/50 hover:text-white">
          ← Roster
        </Link>
      </div>

      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Team member</p>
        <h1 className="text-2xl font-semibold">{displayName}</h1>
        {member.displayName && (
          <p className="text-xs text-white/40 mt-0.5">@{member.githubLogin}</p>
        )}
        <p className="mt-1 text-sm text-white/50">{total} sessions total</p>
      </div>

      <SessionsTable sessions={sessions} total={total} currentPage={page} basePath={basePath} />
    </div>
  );
}
