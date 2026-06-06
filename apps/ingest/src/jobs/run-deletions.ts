import type { PrismaClient } from '@ai-agents-observability/db';
import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

/**
 * Processes pending DeletionRequest rows.
 * For each request: deletes S3 transcript objects, then cascades the Prisma
 * user delete (which cascades to sessions, events FK, PR links, audit logs via
 * ON DELETE CASCADE defined in schema).
 * Uses pg advisory lock to prevent concurrent runs.
 */
export async function runDeletions(
  db: PrismaClient,
  s3: S3Client,
  bucket: string,
  logger?: Logger,
): Promise<void> {
  const jobName = 'run-deletions';
  const startedAt = new Date();

  const lockResult = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;

  if (!lockResult[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({
      data: { jobName, startedAt, status: 'running' },
    });
    jobRunId = jobRun.id;

    const pending = await db.deletionRequest.findMany({
      include: {
        user: {
          select: {
            githubLogin: true,
            sessions: { select: { sessionId: true, transcriptS3Key: true } },
          },
        },
      },
      where: { processedAt: null },
    });

    let deleted = 0;
    for (const req of pending) {
      try {
        // Delete each transcript from S3
        for (const session of req.user.sessions) {
          if (session.transcriptS3Key) {
            await s3
              .send(new DeleteObjectCommand({ Bucket: bucket, Key: session.transcriptS3Key }))
              .catch((err) => {
                logger?.warn(
                  { err, key: session.transcriptS3Key },
                  'S3 delete failed (continuing)',
                );
              });
          }
        }

        // Remove audit log entries where user is the actor (actor_user_id FK is RESTRICT).
        // Entries where user is the target are SET NULL by FK automatically.
        await db.auditLog.deleteMany({ where: { actorUserId: req.userId } });

        // Cascade-delete the user (sessions, events, PRs deleted by FK CASCADE)
        await db.user.delete({ where: { id: req.userId } });
        deleted++;
        logger?.info(
          { login: req.user.githubLogin, requestId: req.id },
          'Deletion request processed',
        );
      } catch (err) {
        logger?.error({ err, requestId: req.id }, 'Failed to process deletion request');
      }
    }

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });

    logger?.info({ deleted, jobName, total: pending.length }, 'Deletion job complete');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Deletion job failed');
    if (jobRunId !== undefined) {
      await db.jobRun
        .update({
          data: { errorText, finishedAt: new Date(), status: 'error' },
          where: { id: jobRunId },
        })
        .catch(() => {});
    }
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`job:${jobName}`}))`.catch(() => {});
  }
}
