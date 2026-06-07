import type { PrismaClient } from '@ai-agents-observability/db';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

/**
 * Enforces configurable transcript retention.
 * Deletes S3 objects whose corresponding session ended more than
 * `retentionDays` ago, then clears the transcript pointer in Postgres.
 * Also sweeps orphaned S3 keys (objects with no matching session row).
 * Skips if retentionDays === 0 (retention disabled).
 */
export async function runSweepRetention(
  db: PrismaClient,
  s3: S3Client,
  bucket: string,
  retentionDays: number,
  logger?: Logger,
): Promise<void> {
  if (retentionDays === 0) {
    logger?.debug('Transcript retention disabled (TRANSCRIPT_RETENTION_DAYS=0), skipping');
    return;
  }

  const jobName = 'sweep-retention';
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

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Find sessions with transcripts older than retention window
    const expired = await db.session.findMany({
      select: { sessionId: true, transcriptS3Key: true },
      where: {
        transcriptS3Key: { not: null },
        transcriptUploadedAt: { lt: cutoff },
      },
    });

    let purged = 0;
    for (const session of expired) {
      if (!session.transcriptS3Key) {
        continue;
      }
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: session.transcriptS3Key }));
        await db.session.update({
          data: {
            transcriptBytes: null,
            transcriptS3Key: null,
            transcriptUploadedAt: null,
          },
          where: { sessionId: session.sessionId },
        });
        purged++;
      } catch (err) {
        logger?.warn({ err, sessionId: session.sessionId }, 'Failed to purge transcript');
      }
    }

    // Sweep orphaned S3 keys: list objects under transcripts/ and check for
    // sessions that no longer exist
    let orphans = 0;
    let continuationToken: string | undefined;
    const knownKeys = new Set(expired.map((s) => s.transcriptS3Key).filter(Boolean));

    do {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
          MaxKeys: 500,
          Prefix: 'transcripts/',
        }),
      );

      const keys = (list.Contents ?? []).map((o) => o.Key).filter(Boolean) as string[];

      // Batch-check which keys have a matching session
      if (keys.length > 0) {
        const rows = await db.session.findMany({
          select: { transcriptS3Key: true },
          where: { transcriptS3Key: { in: keys } },
        });
        const trackedKeys = new Set(rows.map((r) => r.transcriptS3Key));

        const orphanKeys = keys.filter((key) => !trackedKeys.has(key) && !knownKeys.has(key));
        if (orphanKeys.length > 0) {
          await s3
            .send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: orphanKeys.map((Key) => ({ Key })) },
              }),
            )
            .then((res) => {
              orphans += res.Deleted?.length ?? 0;
              for (const err of res.Errors ?? []) {
                logger?.warn({ key: err.Key, message: err.Message }, 'Failed to delete orphan');
              }
            })
            .catch((err) => logger?.warn({ err }, 'Failed to batch-delete orphans'));
        }
      }

      continuationToken = list.NextContinuationToken;
    } while (continuationToken);

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });

    logger?.info(
      { jobName, orphans, purged, retentionDays, total: expired.length },
      'Retention sweep complete',
    );
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Retention sweep failed');
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
