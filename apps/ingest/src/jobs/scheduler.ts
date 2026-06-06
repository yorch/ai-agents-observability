import type { PrismaClient } from '@ai-agents-observability/db';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import { runComputeEffectiveness } from './compute-effectiveness';
import { runIndexTranscripts } from './index-transcripts';
import { runDeletions } from './run-deletions';
import { runSweepAbandoned } from './sweep-abandoned';
import { runSweepRetention } from './sweep-retention';
import { runSweepScratch } from './sweep-scratch';
import { runSyncTeams } from './sync-teams';

export type SchedulerDeps = {
  bucket: string;
  db: PrismaClient;
  githubSyncToken?: string;
  logger?: Logger;
  s3: S3Client;
  transcriptRetentionDays: number;
};

// Jobs whose hour+minute schedule is stored in job_config and editable from the UI.
const CONFIGURABLE_JOBS = [
  'sweep-retention',
  'index-transcripts',
  'compute-effectiveness',
] as const;
type ConfigurableJob = (typeof CONFIGURABLE_JOBS)[number];

// Default seeds — inserted with ON CONFLICT DO NOTHING on startup.
const JOB_DEFAULTS: Record<ConfigurableJob, { runHourUtc: number; runMinuteUtc: number }> = {
  'compute-effectiveness': { runHourUtc: 5, runMinuteUtc: 0 },
  'index-transcripts': { runHourUtc: 3, runMinuteUtc: 30 },
  'sweep-retention': { runHourUtc: 2, runMinuteUtc: 0 },
};

// All job names accepted by the manual-trigger endpoint.
const ALL_KNOWN_JOBS = new Set<string>([
  'sync-teams',
  'sweep-abandoned',
  'sweep-scratch',
  'run-deletions',
  ...CONFIGURABLE_JOBS,
]);

export function isKnownJob(name: string): boolean {
  return ALL_KNOWN_JOBS.has(name);
}

function slotKey(hour: number, minute: number, date: Date): string {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000);
  return `${hour}:${minute}:${dayOfYear}`;
}

/** Dispatch a named job using the full deps context. */
export async function triggerJob(deps: SchedulerDeps, jobName: string): Promise<void> {
  const { bucket, db, githubSyncToken, logger, s3, transcriptRetentionDays } = deps;
  switch (jobName) {
    case 'sync-teams':
      await runSyncTeams(db, githubSyncToken, logger);
      break;
    case 'sweep-abandoned':
      await runSweepAbandoned(db, logger);
      break;
    case 'sweep-scratch':
      await runSweepScratch(logger);
      break;
    case 'run-deletions':
      await runDeletions(db, s3, bucket, logger);
      break;
    case 'sweep-retention':
      await runSweepRetention(db, s3, bucket, transcriptRetentionDays, logger);
      break;
    case 'index-transcripts':
      await runIndexTranscripts(
        db as Parameters<typeof runIndexTranscripts>[0],
        s3,
        bucket,
        logger,
      );
      break;
    case 'compute-effectiveness':
      await runComputeEffectiveness(db as Parameters<typeof runComputeEffectiveness>[0], logger);
      break;
    default:
      logger?.warn({ jobName }, 'triggerJob: unknown job name');
  }
}

export function startScheduler(deps: SchedulerDeps): void {
  const { db, githubSyncToken, logger } = deps;

  // Seed default config rows for DB-driven jobs (idempotent).
  void (async () => {
    try {
      for (const jobName of CONFIGURABLE_JOBS) {
        const { runHourUtc, runMinuteUtc } = JOB_DEFAULTS[jobName];
        await db.$executeRaw`
          INSERT INTO job_config (job_name, enabled, run_hour_utc, run_minute_utc)
          VALUES (${jobName}, true, ${runHourUtc}, ${runMinuteUtc})
          ON CONFLICT (job_name) DO NOTHING
        `;
      }
      logger?.info('Scheduler: seeded job_config defaults');
    } catch (err) {
      logger?.error({ err }, 'Scheduler: failed to seed job_config defaults');
    }
  })();

  // Tracks which slot each configurable job last ran in (prevents double-firing).
  const lastRanMinute = new Map<string, string>();

  // ── DB-driven configurable nightly jobs — polled every 60 s ─────────────────
  const pollInterval = setInterval(() => {
    void (async () => {
      const now = new Date();
      const hour = now.getUTCHours();
      const minute = now.getUTCMinutes();
      const currentSlot = slotKey(hour, minute, now);

      let configs: Array<{
        enabled: boolean;
        jobName: string;
        runHourUtc: number;
        runMinuteUtc: number;
        runRequestedAt: Date | null;
      }>;

      try {
        configs = await db.jobConfig.findMany();
      } catch (err) {
        logger?.error({ err }, 'Scheduler: failed to fetch job_config');
        return;
      }

      for (const cfg of configs) {
        // Manual-trigger path: runRequestedAt set by web UI.
        if (cfg.runRequestedAt) {
          const recentRun = await db.jobRun
            .findFirst({
              where: { jobName: cfg.jobName, startedAt: { gt: cfg.runRequestedAt } },
            })
            .catch(() => null);

          if (!recentRun) {
            logger?.info({ jobName: cfg.jobName }, 'Scheduler: manual run requested');
            // Clear flag before launching to prevent double-firing on next poll.
            await db.jobConfig
              .update({ data: { runRequestedAt: null }, where: { jobName: cfg.jobName } })
              .catch(() => {});
            triggerJob(deps, cfg.jobName).catch((err) => {
              logger?.error({ err, jobName: cfg.jobName }, 'Scheduler: manual run error');
            });
          }
          continue;
        }

        // Scheduled-run path.
        if (!cfg.enabled) {
          continue;
        }
        if (cfg.runHourUtc !== hour || cfg.runMinuteUtc !== minute) {
          continue;
        }
        if (lastRanMinute.get(cfg.jobName) === currentSlot) {
          continue;
        }

        lastRanMinute.set(cfg.jobName, currentSlot);
        logger?.info({ hour, jobName: cfg.jobName, minute }, 'Scheduler: firing scheduled job');
        triggerJob(deps, cfg.jobName).catch((err) => {
          logger?.error({ err, jobName: cfg.jobName }, 'Scheduler: scheduled job error');
        });
      }
    })();
  }, 60_000);
  pollInterval.unref?.();

  // ── Fixed-cadence sub-hourly jobs (not yet configurable via UI) ──────────────

  const syncTeamsInterval = setInterval(
    () => {
      runSyncTeams(db, githubSyncToken, logger).catch((err) => {
        logger?.error({ err }, 'Unhandled error in sync-teams job');
      });
    },
    60 * 60 * 1_000,
  );
  syncTeamsInterval.unref?.();

  const sweepAbandonedInterval = setInterval(
    () => {
      runSweepAbandoned(db, logger).catch((err) => {
        logger?.error({ err }, 'Unhandled error in sweep-abandoned job');
      });
    },
    10 * 60 * 1_000,
  );
  sweepAbandonedInterval.unref?.();

  const sweepScratchInterval = setInterval(
    () => {
      runSweepScratch(logger).catch((err) => {
        logger?.error({ err }, 'Unhandled error in sweep-scratch job');
      });
    },
    60 * 60 * 1_000,
  );
  sweepScratchInterval.unref?.();

  // Every 6 h: GDPR deletion (high-priority, fixed cadence).
  const deletionsInterval = setInterval(
    () => {
      triggerJob(deps, 'run-deletions').catch((err) => {
        logger?.error({ err }, 'Unhandled error in run-deletions job');
      });
    },
    6 * 60 * 60 * 1_000,
  );
  deletionsInterval.unref?.();

  logger?.info(
    'Job scheduler started (DB-poll every 60s: sweep-retention/index-transcripts/compute-effectiveness; fixed: sync-teams 1h, sweep-abandoned 10m, sweep-scratch 1h, run-deletions 6h)',
  );
}
