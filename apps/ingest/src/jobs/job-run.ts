import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

export type JobRunDb = Pick<PrismaClient, 'jobRun'> & {
  $queryRaw: PrismaClient['$queryRaw'];
};

/**
 * Standard job scaffold: pg advisory lock (skip if another instance holds it),
 * a JobRun row for observability, success/error status updates, unlock in
 * finally. New jobs should run through this instead of re-pasting the
 * boilerplate (sync-teams/reconcile-cost predate it and still inline it).
 */
export async function withJobRun(
  db: JobRunDb,
  jobName: string,
  logger: Logger | undefined,
  fn: () => Promise<void>,
): Promise<void> {
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
      data: { jobName, startedAt: new Date(), status: 'running' },
    });
    jobRunId = jobRun.id;

    await fn();

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Job failed');
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
