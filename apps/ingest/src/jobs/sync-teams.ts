import type { PrismaClient } from '@ai-agents-observability/db';
import { createGitHubClient, getOrgTeams, getTeamMembers } from '@ai-agents-observability/github';
import type { Logger } from 'pino';

/**
 * Org-wide reconciler for Team + TeamMember rows from GitHub orgs.
 * Uses pg advisory lock to avoid duplicate concurrent runs.
 * Writes a JobRun row for observability.
 *
 * This complements the per-user sync that runs at login
 * (`GitHubProvider.fetchTeams` → `syncLoginTeams` in apps/web): a developer's
 * own membership is current the moment they sign in, and this cron catches
 * membership changes for users who are not actively logging in.
 *
 * NOTE: per-user GitHub OAuth tokens are not persisted, so this job runs with a
 * single shared `githubSyncToken` (a service/org token). Without it, the job
 * logs a warning and no-ops — login-time sync still keeps active users current.
 */
export async function runSyncTeams(
  db: PrismaClient,
  githubSyncToken: string | undefined,
  logger?: Logger,
): Promise<void> {
  const jobName = 'sync-teams';
  const startedAt = new Date();

  // Try to acquire advisory lock
  const lockResult = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;

  if (!lockResult[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping job run');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({
      data: {
        jobName,
        startedAt,
        status: 'running',
      },
    });
    jobRunId = jobRun.id;

    // Per-user OAuth tokens are not persisted; the shared token (if any) drives
    // org-wide reconciliation, while login-time sync covers active users.
    const users = await db.user.findMany({
      select: {
        githubLogin: true,
        id: true,
      },
      where: {
        deactivatedAt: null,
        githubLogin: { not: null },
      },
    });

    logger?.info({ count: users.length, jobName }, 'Processing users for team sync');

    for (const user of users) {
      // No shared service token configured — login-time sync still covers
      // active users, so this is a soft skip rather than an error.
      if (!githubSyncToken) {
        logger?.warn(
          { githubLogin: user.githubLogin, userId: user.id },
          'No shared GitHub sync token configured; relying on login-time team sync for this user',
        );
        continue;
      }

      try {
        await syncUserTeams(db, user.id, user.githubLogin as string, githubSyncToken, logger);
      } catch (err) {
        // Log but don't fail entire job for one user
        logger?.error({ err, userId: user.id }, 'Failed to sync teams for user');
      }
    }

    await db.jobRun.update({
      data: {
        finishedAt: new Date(),
        status: 'success',
      },
      where: { id: jobRunId },
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Job failed');
    if (jobRunId !== undefined) {
      await db.jobRun
        .update({
          data: {
            errorText,
            finishedAt: new Date(),
            status: 'error',
          },
          where: { id: jobRunId },
        })
        .catch(() => {});
    }
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`job:${jobName}`}))`.catch(() => {});
  }
}

async function syncUserTeams(
  db: PrismaClient,
  _userId: string,
  githubLogin: string,
  githubToken: string,
  logger?: Logger,
): Promise<void> {
  const client = createGitHubClient({ token: githubToken });

  // Get the user's orgs
  const orgsResponse = await client.rest.orgs.listForUser({ username: githubLogin });
  const orgs = orgsResponse.data;

  for (const org of orgs) {
    let teams: Awaited<ReturnType<typeof getOrgTeams>>;
    try {
      teams = await getOrgTeams(client, org.login);
    } catch (err) {
      logger?.warn({ err, org: org.login }, 'Failed to list teams for org, skipping');
      continue;
    }

    for (const team of teams) {
      // Upsert Team row
      const dbTeam = await db.team.upsert({
        create: {
          githubId: BigInt(team.id),
          githubSlug: `${org.login}/${team.slug}`,
          name: team.name,
          syncedAt: new Date(),
        },
        update: {
          name: team.name,
          syncedAt: new Date(),
        },
        where: { githubId: BigInt(team.id) },
      });

      // Get current members from GitHub
      let members: Awaited<ReturnType<typeof getTeamMembers>>;
      try {
        members = await getTeamMembers(client, org.login, team.slug);
      } catch (err) {
        logger?.warn({ err, team: team.slug }, 'Failed to list team members, skipping');
        continue;
      }

      const memberLogins = new Set(members.map((m) => m.login));

      // Get DB users that are in this team by github login
      const dbUsers = await db.user.findMany({
        select: { githubLogin: true, id: true },
        where: { githubLogin: { in: Array.from(memberLogins) } },
      });

      const dbUserIds = new Set(dbUsers.map((u) => u.id));

      // Upsert TeamMember rows for active members
      for (const dbUser of dbUsers) {
        await db.teamMember.upsert({
          create: {
            leftAt: null,
            roleInTeam: 'member',
            syncedAt: new Date(),
            teamId: dbTeam.id,
            userId: dbUser.id,
          },
          update: {
            leftAt: null,
            syncedAt: new Date(),
          },
          where: { teamId_userId: { teamId: dbTeam.id, userId: dbUser.id } },
        });
      }

      // Soft-delete members that are no longer in the team
      await db.teamMember.updateMany({
        data: { leftAt: new Date() },
        where: {
          leftAt: null,
          teamId: dbTeam.id,
          userId: { notIn: Array.from(dbUserIds) },
        },
      });

      logger?.debug({ memberCount: dbUsers.length, team: team.slug }, 'Synced team members');
    }
  }
}
