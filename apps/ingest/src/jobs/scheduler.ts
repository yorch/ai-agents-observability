import type { PrismaClient } from '@ai-agents-observability/db';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import type { JudgeModelClient } from '../lib/judge-client';
import type { EmailConfig } from '../lib/notify/email';
import type { PriceTableRegistry } from '../lib/price-tables';
import { runBackfillRedaction } from './backfill-redaction';
import { runComputeCostAttribution } from './compute-cost-attribution';
import {
  runComputeEffectiveness,
  runComputeEffectivenessBackfill,
  runRescoreEffectiveness,
} from './compute-effectiveness';
import { runComputeSubjectScores } from './compute-subject-scores';
import { runComputeTrajectoryScores, runRescoreTrajectory } from './compute-trajectory-scores';
import { runEvaluateAlerts } from './evaluate-alerts';
import { runIndexTranscripts } from './index-transcripts';
import { type JudgeRunConfig, runJudgeSessions } from './judge-sessions';
import { runLinkTurnEvents } from './link-turn-events';
import { type BillingSource, NullBillingSource, runReconcileCost } from './reconcile-cost';
import { runRepriceEvents } from './reprice-events';
import { runDeletions } from './run-deletions';
import { runSweepAbandoned } from './sweep-abandoned';
import { runSweepRetention } from './sweep-retention';
import { runSweepScratch } from './sweep-scratch';
import { type JiraSyncConfig, runSyncJira } from './sync-jira';
import { runSyncTeams } from './sync-teams';

export type SchedulerDeps = {
  appBaseUrl?: string;
  // Vendor-cost source for reconcile-cost. Undefined → NullBillingSource (the
  // job runs but records no drift). Wired to AnthropicBillingSource in index.ts
  // when ANTHROPIC_ADMIN_KEY is configured.
  billingSource?: BillingSource;
  billingReconciliationEnabled?: boolean;
  bucket: string;
  db: PrismaClient;
  // SMTP config for the email alert channel (P9-002). Undefined when SMTP is not
  // configured — email alerts then fail loud rather than delivering silently.
  emailConfig?: EmailConfig;
  githubSyncToken?: string;
  // Jira issue-metadata sync (env-gated like reconcile-cost) — undefined when
  // JIRA_BASE_URL / JIRA_API_TOKEN are not configured.
  jiraConfig?: JiraSyncConfig;
  // LLM-as-judge (P13-009) — undefined unless BOTH a judge API key and an
  // operator user id are configured *and* the configured model has a registered
  // revision. Undefined means the scheduled entry no-ops with a warning; there
  // is no half-configured state in which the judge reads a transcript.
  judge?: { client: JudgeModelClient; config: JudgeRunConfig };
  logger?: Logger;
  orgMaxRetentionDays: number;
  // Price tables for reprice-events. Undefined → the reprice jobs no-op with a
  // warning rather than rewriting cost against a table that was never wired.
  priceTables?: PriceTableRegistry;
  s3: S3Client;
  transcriptRetentionDays: number;
};

// Jobs whose hour+minute schedule is stored in job_config and editable from the UI.
const CONFIGURABLE_JOBS = [
  'sweep-retention',
  'index-transcripts',
  'compute-effectiveness',
  // Deterministic trajectory scorers (P13-003) and skill/MCP subject scores
  // (P13-004). Scheduled after compute-effectiveness so the shape labels the
  // step-efficiency baseline is bucketed by are already written for the night's
  // sessions — a session scored before its shape exists gets no baseline and
  // (correctly) no step-efficiency row, but it would then wait a whole day.
  'compute-trajectory-scores',
  'compute-subject-scores',
  // Live turn linkage (P14-006). MUST be scheduled before
  // compute-cost-attribution: it writes the `turn_number` / `parent_event_id`
  // that job selects on, so running it after would leave every live session's
  // tool calls unattributed for a further day. Configurable rather than
  // fixed-timer for the same reason the attribution job is — the two are one
  // pipeline and an operator moving one should be able to move the other.
  'link-turn-events',
  // Turn-linked cost attribution (P14-004). Scheduled after the scorers so it
  // runs on a quiet part of the night; it depends on nothing they write. It is
  // configurable rather than fixed-timer because how far behind "yesterday's
  // cost by tool" is allowed to be is an operator's call, not a constant.
  'compute-cost-attribution',
  'evaluate-alerts',
  // LLM-as-judge (P13-009). Seeded **disabled** — a fresh deployment never
  // sends a transcript to a model because a container booted.
  'judge-sessions',
] as const;

// All job names accepted by the manual-trigger endpoint. sync-jira is included
// so an operator can trigger a first sync right after configuring credentials —
// it no-ops with a warning when Jira is not configured. backfill-redaction is
// included so an operator can drain the pre-column redaction_flags backlog
// after deploy (one trigger drains the whole backlog — see backfill-redaction.ts).
//
// The two reprice-events names are one job behind a safety interlock: the bare
// name only reports, `-apply` writes. The trigger endpoint takes no body, so a
// flag would have had nowhere to live — and repricing history by default is not
// a mistake worth making available.
const ALL_KNOWN_JOBS = new Set<string>([
  'sync-teams',
  'sync-jira',
  'sweep-abandoned',
  'sweep-scratch',
  'run-deletions',
  'backfill-redaction',
  'reprice-events',
  'reprice-events-apply',
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
  const {
    appBaseUrl,
    billingSource,
    bucket,
    db,
    emailConfig,
    githubSyncToken,
    jiraConfig,
    judge,
    logger,
    orgMaxRetentionDays,
    priceTables,
    s3,
    transcriptRetentionDays,
  } = deps;
  switch (jobName) {
    case 'sync-teams':
      await runSyncTeams(db, githubSyncToken, logger);
      break;
    // Gated Jira issue-metadata sync — no-ops unless Jira credentials are configured.
    case 'sync-jira':
      if (jiraConfig) {
        await runSyncJira(db, jiraConfig, logger);
      } else {
        logger?.warn('sync-jira: skipped, Jira is not configured');
      }
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
      await runSweepRetention(db, s3, bucket, transcriptRetentionDays, orgMaxRetentionDays, logger);
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
    // Deterministic trajectory scorers (P13-003). Writes `scores` rows only —
    // nothing here is surfaced on a dashboard until P13-007 says whether these
    // numbers predict anything.
    case 'compute-trajectory-scores':
      await runComputeTrajectoryScores(
        db as Parameters<typeof runComputeTrajectoryScores>[0],
        logger,
      );
      break;
    // Live turn linkage (P14-006): joins live tool events to the assistant turn
    // that issued them on `(session_id, tool_use_id)`, the natural key both the
    // hook payload and the transcript spell identically. Writes `turn_number`
    // and `parent_event_id` and nothing else, only ever onto rows where they are
    // NULL — so an imported session's captured linkage is never overwritten.
    // Needs no price-table registry: it moves no money, it only says which turn
    // a call belongs to.
    case 'link-turn-events':
      await runLinkTurnEvents(db as Parameters<typeof runLinkTurnEvents>[0], { logger });
      break;
    // Turn-linked cost attribution (P14-004): redistributes each assistant
    // turn's cost onto the tool calls that turn issued, and the following turn's
    // input-side cost onto the tool outputs that inflated it. Writes two columns
    // on `events` and nothing else — the session/PR/cagg cost chain is
    // deliberately untouched. Gated on the price-table registry for the same
    // reason reprice-events is: the downstream half prices tokens.
    case 'compute-cost-attribution':
      if (!priceTables) {
        logger?.warn(
          { jobName },
          'compute-cost-attribution: skipped, no price-table registry wired',
        );
        break;
      }
      await runComputeCostAttribution(
        db as Parameters<typeof runComputeCostAttribution>[0],
        priceTables,
        { logger },
      );
      break;
    // Skill / MCP-server score rows (P13-004) — the persisted trend behind the
    // read-time comparison panels.
    case 'compute-subject-scores':
      await runComputeSubjectScores(db as Parameters<typeof runComputeSubjectScores>[0], logger);
      break;
    // LLM-as-judge over sampled transcripts (P13-009). Gated on config
    // presence: no judge credentials (or an unregistered model) means the job
    // does nothing at all rather than falling back to some default judge.
    case 'judge-sessions':
      if (judge) {
        await runJudgeSessions(
          db as Parameters<typeof runJudgeSessions>[0],
          s3,
          bucket,
          judge.config,
          judge.client,
          logger,
        );
      } else {
        logger?.warn('judge-sessions: skipped, the judge is not configured');
      }
      break;
    // Scheduled alert evaluation (P9-001). Records firing/resolving transitions.
    case 'evaluate-alerts':
      await runEvaluateAlerts(
        db as Parameters<typeof runEvaluateAlerts>[0],
        logger,
        appBaseUrl,
        emailConfig,
      );
      break;
    // One-shot historical backfill (P7-001). Dispatchable here for operator-run
    // scripts; deliberately absent from CONFIGURABLE_JOBS (no cadence) and
    // ALL_KNOWN_JOBS (not reachable via the HTTP manual-trigger endpoint).
    case 'compute-effectiveness-backfill':
      await runComputeEffectivenessBackfill(
        db as Parameters<typeof runComputeEffectivenessBackfill>[0],
        logger,
      );
      break;
    // Operator-triggered one-shot (P13-001): re-score every session whose
    // `scores` rows are behind the current scorer version. This is the path that
    // makes a scorer change cheap — bump FRICTION_VERSION or
    // SESSION_SHAPE_VERSION, trigger once. Like the backfill above it has no
    // cadence, so it stays out of CONFIGURABLE_JOBS.
    case 'rescore-effectiveness':
      await runRescoreEffectiveness(db as Parameters<typeof runRescoreEffectiveness>[0], logger);
      break;
    // Operator-triggered one-shot (P13-003): re-score every session's trajectory
    // after bumping one of the six trajectory scorer versions. No cadence, so it
    // stays out of CONFIGURABLE_JOBS like its effectiveness counterpart.
    case 'rescore-trajectory':
      await runRescoreTrajectory(db as Parameters<typeof runRescoreTrajectory>[0], logger);
      break;
    // Operator-triggered one-shot: backfill sessions.redaction_flags for
    // transcripts archived before the column existed, by scanning stored
    // (already-redacted) transcript text for [REDACTED:<class>] markers.
    case 'backfill-redaction':
      await runBackfillRedaction(
        db as Parameters<typeof runBackfillRedaction>[0],
        s3,
        bucket,
        logger,
      );
      break;
    // Gated cost reconciliation (P8-006). Uses the wired billing source
    // (AnthropicBillingSource when ANTHROPIC_ADMIN_KEY is set), else the
    // NullBillingSource no-op so the job still runs (records no drift).
    case 'reconcile-cost':
      await runReconcileCost(
        db as Parameters<typeof runReconcileCost>[0],
        billingSource ?? new NullBillingSource(),
        {
          logger,
        },
      );
      break;
    // Operator-triggered reprice of historical cost against the *current* price
    // tables (P12-011). Two names, one job: the bare name reports what would
    // change, `-apply` writes it. See reprice-events.ts for why history does not
    // self-correct when a price table is fixed.
    case 'reprice-events':
    case 'reprice-events-apply':
      if (!priceTables) {
        logger?.warn({ jobName }, 'reprice-events: skipped, no price-table registry wired');
        break;
      }
      await runRepriceEvents(db as Parameters<typeof runRepriceEvents>[0], priceTables, {
        apply: jobName === 'reprice-events-apply',
        logger,
      });
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
          ('compute-effectiveness', true, 5, 0),
          ('compute-trajectory-scores', true, 5, 30),
          ('compute-subject-scores',    true, 6, 0),
          -- P14-006 before P14-004: the attribution job selects on the linkage
          -- this one writes.
          ('link-turn-events',           true, 6, 10),
          ('compute-cost-attribution',   true, 6, 15),
          ('evaluate-alerts',       true, 1, 0),
          -- P13-009: off by default. Enabling it is an operator decision taken
          -- in /admin/jobs, not a consequence of deploying.
          ('judge-sessions',        false, 6, 30)
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
      const start = Date.now();
      fn()
        .then(() => {
          logger?.info(
            { duration_ms: Date.now() - start, jobName: name },
            'Scheduler: job completed',
          );
        })
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

  // Jira issue-metadata sync — gated on Jira credentials. Every 6h; the job
  // itself skips issues with a fresh (<6h) snapshot, so the tick is idempotent.
  if (deps.jiraConfig) {
    const syncJiraInterval = setInterval(
      guarded(() => triggerJob(deps, 'sync-jira'), 'sync-jira'),
      6 * 60 * 60 * 1_000,
    );
    syncJiraInterval.unref?.();
  }

  // Cost reconciliation (P8-006) — gated, disabled by default. Daily timer but
  // always reconciles the previous calendar month, so a daily tick is idempotent.
  if (deps.billingReconciliationEnabled) {
    const reconcileInterval = setInterval(
      guarded(() => triggerJob(deps, 'reconcile-cost'), 'reconcile-cost'),
      24 * 60 * 60 * 1_000,
    );
    reconcileInterval.unref?.();
  }

  logger?.info(
    {
      judge: deps.judge !== undefined,
      reconcileCost: deps.billingReconciliationEnabled === true,
      reconcileCostSource: deps.billingSource ? 'anthropic' : 'null',
      syncJira: deps.jiraConfig !== undefined,
    },
    'Job scheduler started (DB-poll every 60s for the job_config cadences: sweep-retention, index-transcripts, compute-effectiveness, compute-trajectory-scores, compute-subject-scores, link-turn-events, compute-cost-attribution, evaluate-alerts, judge-sessions; fixed: sync-teams 1h, sweep-abandoned 10m, sweep-scratch 1h, run-deletions 6h; sync-jira 6h when configured; reconcile-cost daily when enabled)',
  );
}
