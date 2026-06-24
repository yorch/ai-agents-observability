import type { TeamMembership } from '@ai-agents-observability/auth';
import type { PrismaClient } from '@ai-agents-observability/db';

/**
 * Upserts Team + TeamMember rows for a single user from the team list fetched at
 * login time (see `GitHubProvider.fetchTeams`). This is the per-user complement
 * to the org-wide `sync-teams` cron job in apps/ingest: it keeps a developer's
 * own team membership current the moment they sign in, which is what gates the
 * team-views privacy model — without it, `/team/*` has no membership data.
 *
 * Memberships the user no longer has are soft-deleted (`leftAt` set), mirroring
 * the cron job's reconciliation.
 */
export async function syncLoginTeams(
  db: PrismaClient,
  userId: string,
  memberships: TeamMembership[],
): Promise<void> {
  // An empty membership list is ambiguous: the user may genuinely be on no
  // teams, but it also results from a token-less provider (e.g. NoopProvider in
  // dev) or a transient GitHub error that returns 200 + []. Treating it as
  // authoritative would soft-delete every membership and lock the user out of
  // /team/*, so bail before any destructive reconciliation — org-wide departure
  // handling is owned by the sync-teams cron.
  if (memberships.length === 0) {
    return;
  }

  const now = new Date();
  const teamIds: string[] = [];

  for (const m of memberships) {
    const team = await db.team.upsert({
      create: {
        githubId: BigInt(m.team_github_id),
        githubSlug: `${m.org}/${m.team_slug}`,
        name: m.team_name,
        syncedAt: now,
      },
      update: {
        githubSlug: `${m.org}/${m.team_slug}`,
        name: m.team_name,
        syncedAt: now,
      },
      where: { githubId: BigInt(m.team_github_id) },
    });

    await db.teamMember.upsert({
      create: {
        leftAt: null,
        roleInTeam: m.role === 'maintainer' ? 'MAINTAINER' : 'MEMBER',
        syncedAt: now,
        teamId: team.id,
        userId,
      },
      // Deliberately NOT updating roleInTeam: GitHub's /user/teams endpoint
      // can't report maintainer, so `m.role` is always 'member'. Writing it on
      // every login would downgrade a lead/maintainer promoted elsewhere (the
      // cron, or a manual grant). Role is set once on first insert, then left
      // untouched.
      update: {
        leftAt: null,
        syncedAt: now,
      },
      where: { teamId_userId: { teamId: team.id, userId } },
    });

    teamIds.push(team.id);
  }

  // Reconcile departures: soft-delete this user's active memberships for teams
  // we did NOT just observe. `teamIds` is non-empty here, so `notIn` is safe.
  await db.teamMember.updateMany({
    data: { leftAt: now },
    where: { leftAt: null, teamId: { notIn: teamIds }, userId },
  });
}
