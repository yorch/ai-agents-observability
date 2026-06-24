import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

/**
 * Sweeps sessions with status='ACTIVE' and lastEventAt < now() - 24h to status='ABANDONED'.
 * Uses pg advisory lock to avoid duplicate concurrent runs.
 * Writes a JobRun row for observability.
 */
export async function runSweepAbandoned(db: PrismaClient, logger?: Logger): Promise<void> {
  const jobName = 'sweep-abandoned';
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
    // Create a running JobRun record
    const jobRun = await db.jobRun.create({
      data: {
        jobName,
        startedAt,
        status: 'running',
      },
    });
    jobRunId = jobRun.id;

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await db.session.updateMany({
      data: { status: 'ABANDONED' },
      where: {
        lastEventAt: { lt: cutoff },
        status: 'ACTIVE',
      },
    });

    logger?.info({ count: result.count, jobName }, 'Swept abandoned sessions');

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
        .catch(() => {
          // Ignore update failure
        });
    }
  } finally {
    // Release advisory lock
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`job:${jobName}`}))`.catch(() => {
      // Ignore unlock failure
    });
  }
}
