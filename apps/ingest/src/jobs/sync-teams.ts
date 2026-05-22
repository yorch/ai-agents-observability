import type { PrismaClient } from '@ai-agents-observability/db';
import { createGitHubClient, getOrgTeams, getTeamMembers } from '@ai-agents-observability/github';
import type { Logger } from 'pino';

/**
 * Syncs Team + TeamMember rows from GitHub orgs for all users.
 * Uses pg advisory lock to avoid duplicate concurrent runs.
 * Writes a JobRun row for observability.
 *
 * NOTE: GitHub tokens are not currently stored on User rows — this job
 * logs a warning and skips users without tokens. Token storage will be
 * wired up in Phase 4 when the credential store is added.
 */
export async function runSyncTeams(db: PrismaClient, logger?: Logger): Promise<void> {
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

    // Get all users (GitHub token storage is out of scope — skip gracefully)
    const users = await db.user.findMany({
      select: {
        githubLogin: true,
        id: true,
      },
      where: {
        deactivatedAt: null,
      },
    });

    logger?.info({ count: users.length, jobName }, 'Processing users for team sync');

    for (const user of users) {
      // Tokens are not stored on User yet — this is a stub for future wiring
      const githubToken = process.env.GITHUB_SYNC_TOKEN;
      if (!githubToken) {
        logger?.warn(
          { githubLogin: user.githubLogin, userId: user.id },
          'No GitHub token available for team sync; skipping user (token storage not yet implemented)',
        );
        continue;
      }

      try {
        await syncUserTeams(db, user.id, user.githubLogin, githubToken, logger);
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
