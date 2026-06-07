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

// Returns "YYYY-MM-DDTHH:MM" — unique per minute, used as a dedup key to
// prevent a 60-second poll from firing the same job twice in one minute.
function slotKey(date: Date): string {
  return date.toISOString().slice(0, 16);
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

  // Seed default config rows for DB-driven jobs (idempotent, single round-trip).
  void (async () => {
    try {
      await db.$executeRaw`
        INSERT INTO job_config (job_name, enabled, run_hour_utc, run_minute_utc)
        VALUES
          ('sweep-retention',       true, 2, 0),
          ('index-transcripts',     true, 3, 30),
          ('compute-effectiveness', true, 5, 0)
        ON CONFLICT (job_name) DO NOTHING
      `;
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
      const currentSlot = slotKey(now);

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

      // Batch-fetch the most recent run for all pending manual triggers in one query.
      const pendingTriggers = configs.filter((c) => c.runRequestedAt);
      const recentRuns =
        pendingTriggers.length > 0
          ? await db.jobRun
              .findMany({
                orderBy: { startedAt: 'desc' },
                select: { jobName: true, startedAt: true },
                where: { jobName: { in: pendingTriggers.map((c) => c.jobName) } },
              })
              .catch(() => [] as { jobName: string; startedAt: Date }[])
          : [];
      // recentRuns is ordered startedAt DESC — iterate once, keeping only the
      // first (newest) occurrence per job name so we don't overwrite it with an
      // older run when the same job has multiple history rows.
      const latestRunByJob = new Map<string, Date>();
      for (const r of recentRuns) {
        if (!latestRunByJob.has(r.jobName)) {
          latestRunByJob.set(r.jobName, r.startedAt);
        }
      }

      for (const cfg of configs) {
        // Manual-trigger path: runRequestedAt set by web UI.
        if (cfg.runRequestedAt) {
          const latestRun = latestRunByJob.get(cfg.jobName);
          const recentRun = latestRun && latestRun > cfg.runRequestedAt;

          if (!recentRun) {
            logger?.info({ jobName: cfg.jobName }, 'Scheduler: manual run requested');
            // Clear flag before launching — if the update fails we skip this
            // poll tick rather than risk double-firing on the next one.
            try {
              await db.jobConfig.update({
                data: { runRequestedAt: null },
                where: { jobName: cfg.jobName },
              });
            } catch (err) {
              logger?.warn(
                { err, jobName: cfg.jobName },
                'Scheduler: failed to clear run_requested_at, skipping trigger',
              );
              continue;
            }
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

  // Guards re-entrant invocations: if the previous run is still in-flight when
  // the next interval fires, we skip rather than overlap.
  function guarded(fn: () => Promise<void>, name: string): () => void {
    let running = false;
    return () => {
      if (running) {
        logger?.warn({ jobName: name }, 'Scheduler: skipping re-entrant job invocation');
        return;
      }
      running = true;
      fn()
        .catch((err) => logger?.error({ err }, `Unhandled error in ${name} job`))
        .finally(() => {
          running = false;
        });
    };
  }

  const syncTeamsInterval = setInterval(
    guarded(() => runSyncTeams(db, githubSyncToken, logger), 'sync-teams'),
    60 * 60 * 1_000,
  );
  syncTeamsInterval.unref?.();

  const sweepAbandonedInterval = setInterval(
    guarded(() => runSweepAbandoned(db, logger), 'sweep-abandoned'),
    10 * 60 * 1_000,
  );
  sweepAbandonedInterval.unref?.();

  const sweepScratchInterval = setInterval(
    guarded(async () => {
      await runSweepScratch(logger);
    }, 'sweep-scratch'),
    60 * 60 * 1_000,
  );
  sweepScratchInterval.unref?.();

  // Every 6 h: GDPR deletion (high-priority, fixed cadence).
  const deletionsInterval = setInterval(
    guarded(() => triggerJob(deps, 'run-deletions'), 'run-deletions'),
    6 * 60 * 60 * 1_000,
  );
  deletionsInterval.unref?.();

  logger?.info(
    'Job scheduler started (DB-poll every 60s: sweep-retention/index-transcripts/compute-effectiveness; fixed: sync-teams 1h, sweep-abandoned 10m, sweep-scratch 1h, run-deletions 6h)',
  );
}
