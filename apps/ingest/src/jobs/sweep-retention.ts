import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

export { effectiveRetentionDays } from './retention-policy';

/**
 * Enforces configurable transcript retention, honoring per-team overrides.
 * Deletes S3 objects whose session's transcript is older than the session
 * owner's team's effective retention, then clears the transcript pointer in
 * Postgres. Also sweeps orphaned S3 keys. Skips if the global default is 0
 * (retention disabled org-wide).
 */
export async function runSweepRetention(
  db: PrismaClient,
  s3: S3Client,
  bucket: string,
  retentionDays: number,
  orgMaxRetentionDays: number,
  logger?: Logger,
): Promise<void> {
  // Note: we do NOT early-return when the global default is 0. A global of 0
  // disables retention only for sessions with no per-team override; a team that
  // sets its own retention_days must still be swept (P9-004). The per-row SQL
  // below treats 0 (global or team) as "disabled" via NULLIF and skips those rows.

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

    // Find sessions whose transcript is older than the OWNER's team effective
    // retention. Effective days = team override (if set & non-zero) else the
    // global default; clamped to the org max. `NULLIF(x, 0)` makes 0 mean
    // "disabled" at BOTH levels: a team retention_days of 0 falls back to the
    // global default (it must NEVER mean "delete everything"), and when the
    // resolved value is NULL (global 0 with no override) the row is excluded —
    // retention is disabled for that session. Note LEAST() ignores NULLs, so the
    // `IS NOT NULL` guard is required to keep disabled rows from clamping to the
    // org max. Computed per-row so one query covers every team's policy.
    const expiredRows = await db.$queryRaw<{ session_id: string; transcript_s3_key: string }[]>(
      Prisma.sql`
        SELECT s.session_id::text AS session_id, s.transcript_s3_key
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN teams t ON t.id = u.primary_team_id
        WHERE s.transcript_s3_key IS NOT NULL
          AND COALESCE(NULLIF(t.retention_days, 0), NULLIF(${retentionDays}::int, 0)) IS NOT NULL
          AND s.transcript_uploaded_at <
            NOW() - (LEAST(
                       COALESCE(NULLIF(t.retention_days, 0), NULLIF(${retentionDays}::int, 0)),
                       ${orgMaxRetentionDays}::int
                     ) * INTERVAL '1 day')
      `,
    );
    const expired = expiredRows.map((r) => ({
      sessionId: r.session_id,
      transcriptS3Key: r.transcript_s3_key,
    }));

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
