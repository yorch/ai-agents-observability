import type { PrismaClient } from '@ai-agents-observability/db';
import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import { purgeJudgeRationales } from '../lib/judge-rationales';

/**
 * Processes pending DeletionRequest rows.
 * For each request:
 *  1. Deletes S3 transcript objects (best-effort; errors are logged and skipped).
 *  2. Deletes audit_log rows where the user is the actor (actor_user_id FK is
 *     ON DELETE RESTRICT, so this must happen before user.delete).
 *  3. Deletes the user row (cascades to sessions, events, PR links, and
 *     audit_log rows where the user is the target via ON DELETE SET NULL).
 *     The DeletionRequest row itself is removed by cascade when the user is deleted.
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
        // Batch-delete all transcripts for this user (up to 1000 per S3 request).
        const transcriptKeys = req.user.sessions
          .map((s) => s.transcriptS3Key)
          .filter((k): k is string => k !== null);
        const CHUNK_SIZE = 1000;
        for (let i = 0; i < transcriptKeys.length; i += CHUNK_SIZE) {
          const chunk = transcriptKeys.slice(i, i + CHUNK_SIZE);
          await s3
            .send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: chunk.map((Key) => ({ Key })) },
              }),
            )
            .catch((err) => {
              logger?.warn({ count: chunk.length, err }, 'S3 batch delete failed (continuing)');
            });
        }

        // Remove audit log entries where user is the actor (actor_user_id FK is RESTRICT).
        // Entries where user is the target are SET NULL by FK automatically.
        await db.auditLog.deleteMany({ where: { actorUserId: req.userId } });

        // Scores are keyed by a heterogeneous subject_id (session uuid, skill
        // name, mcp server name), so there is no FK to cascade from — session
        // scores must be deleted explicitly or a GDPR deletion would leave
        // per-session rows behind. Chunked for the same reason as the S3 deletes.
        const sessionIds = req.user.sessions.map((s) => s.sessionId);

        // P13-009: judge rationales are derived from those transcripts and live
        // in S3 under their own prefix, so nothing above has removed them. They
        // must go before the score rows that point at them — once the rows are
        // gone, the keys are unrecoverable and the objects leak forever.
        // `clearRefs: false`: the rows are deleted on the next line.
        await purgeJudgeRationales(db, s3, bucket, sessionIds, { clearRefs: false }, logger);
        for (let i = 0; i < sessionIds.length; i += CHUNK_SIZE) {
          await db.score.deleteMany({
            where: {
              subjectId: { in: sessionIds.slice(i, i + CHUNK_SIZE) },
              subjectType: 'SESSION',
            },
          });
        }

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
