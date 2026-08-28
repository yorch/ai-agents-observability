import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';
import { type ChannelConfigRow, dispatchAlert } from '../lib/notify/channel';
import type { EmailConfig } from '../lib/notify/email';
import type { AlertPayload } from '../lib/notify/payload';

type Summary = { sessions: bigint; cost: string | number };

/** Sends a weekly aggregate report through the existing, audited notification channels. */
export async function runSendReportDigest(
  db: PrismaClient,
  logger?: Logger,
  appBaseUrl = '',
  emailConfig?: EmailConfig,
): Promise<void> {
  const jobName = 'send-report-digest';
  const startedAt = new Date();
  const lock = await db.$queryRaw<
    [{ pg_try_advisory_lock: boolean }]
  >`SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))`;
  if (!lock[0]?.pg_try_advisory_lock) {
    return;
  }
  let jobRunId: bigint | undefined;
  try {
    const run = await db.jobRun.create({ data: { jobName, startedAt, status: 'running' } });
    jobRunId = run.id;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await db.$queryRaw<
      Summary[]
    >`SELECT COUNT(*) AS sessions, COALESCE(SUM(total_cost_usd), 0) AS cost FROM interactive_sessions WHERE started_at >= ${since}`;
    const summary = rows[0] ?? { cost: 0, sessions: 0n };
    const payload: AlertPayload = {
      description: `Weekly agent digest: ${Number(summary.sessions).toLocaleString()} interactive sessions and $${Number(summary.cost).toFixed(2)} telemetry-derived spend in the last 7 days.`,
      firedAt: startedAt.toISOString(),
      ruleName: 'Weekly agent digest',
      severity: 'warn',
      url: `${appBaseUrl}/org/report?range=7`,
    };
    const channels = await db.alertChannelConfig.findMany({ where: { enabled: true } });
    await dispatchAlert(db, channels as ChannelConfigRow[], payload, { emailConfig, logger });
    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Report digest failed');
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
