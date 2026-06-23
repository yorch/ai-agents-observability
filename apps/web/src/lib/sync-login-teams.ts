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
        roleInTeam: m.role,
        syncedAt: now,
        teamId: team.id,
        userId,
      },
      update: {
        leftAt: null,
        roleInTeam: m.role,
        syncedAt: now,
      },
      where: { teamId_userId: { teamId: team.id, userId } },
    });

    teamIds.push(team.id);
  }

  // Soft-delete memberships that are no longer present. An empty `teamIds`
  // (user is on no teams) correctly clears all of this user's active rows.
  await db.teamMember.updateMany({
    data: { leftAt: now },
    where:
      teamIds.length === 0
        ? { leftAt: null, userId }
        : { leftAt: null, teamId: { notIn: teamIds }, userId },
  });
}
