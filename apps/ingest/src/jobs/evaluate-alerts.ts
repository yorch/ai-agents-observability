import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import {
  AUTONOMY_SURGE_CRITICAL,
  AUTONOMY_SURGE_MIN_SESSIONS,
  AUTONOMY_SURGE_WARN,
  AUTONOMY_SURGE_WINDOW_DAYS,
  BUDGET_THRESHOLD_CRITICAL_RATIO,
  BUDGET_THRESHOLD_WARN_RATIO,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  ERROR_RATE_WINDOW_DAYS,
  LOW_OVERSIGHT_MODES,
  parseBudgetThresholdParams,
  SPEND_SPIKE_BASELINE_DAYS,
  SPEND_SPIKE_CRITICAL_SIGMA,
  SPEND_SPIKE_WARN_SIGMA,
  SPEND_SPIKE_WINDOW_DAYS,
  UNKNOWN_MODEL_SURGE_DEFAULT,
  UNKNOWN_MODEL_WINDOW_HOURS,
} from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';

import { dispatchAlert } from '../lib/notify/channel';
import type { EmailConfig } from '../lib/notify/email';
import { buildAlertPayload } from '../lib/notify/payload';
import { type AlertEvaluation, applyAlertTransition } from './alert-transition';

type AlertsDb = Pick<
  PrismaClient,
  'jobRun' | 'alertRule' | 'alertEvent' | 'alertChannelConfig' | 'alertDeliveryLog'
> & {
  $queryRaw: PrismaClient['$queryRaw'];
};

type RuleRow = {
  id: string;
  name: string;
  params: unknown;
  ruleType: string;
};

type Evaluation = AlertEvaluation;

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

async function evalSpendSpike(db: AlertsDb): Promise<Evaluation> {
  const now = Date.now();
  const windowStart = new Date(now - SPEND_SPIKE_WINDOW_DAYS * 86_400_000);
  const baselineStart = new Date(
    now - (SPEND_SPIKE_WINDOW_DAYS + SPEND_SPIKE_BASELINE_DAYS) * 86_400_000,
  );

  const rows = await db.$queryRaw<{ avg_cost: number; current: number; stddev_cost: number }[]>(
    Prisma.sql`
      WITH cur AS (
        SELECT COALESCE(SUM(s.total_cost_usd), 0) AS current
        FROM sessions s
        JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE s.started_at >= ${windowStart}
          AND COALESCE(vp.share_metadata_with_org, true) = true
      ),
      base AS (
        SELECT AVG(daily) AS avg_cost, STDDEV(daily) AS stddev_cost
        FROM (
          SELECT date_trunc('day', s.started_at) AS day, SUM(s.total_cost_usd) AS daily
          FROM sessions s
          JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
          LEFT JOIN visibility_policies vp ON vp.user_id = u.id
          WHERE s.started_at >= ${baselineStart} AND s.started_at < ${windowStart}
            AND COALESCE(vp.share_metadata_with_org, true) = true
          GROUP BY date_trunc('day', s.started_at)
        ) d
      )
      SELECT cur.current, base.avg_cost, base.stddev_cost FROM cur, base
    `,
  );

  const current = Number(rows[0]?.current ?? 0);
  const avg = Number(rows[0]?.avg_cost ?? 0);
  const stddev = Number(rows[0]?.stddev_cost ?? 0);
  if (avg <= 0 || stddev <= 0 || current <= avg + SPEND_SPIKE_WARN_SIGMA * stddev) {
    return null;
  }
  return {
    details: {
      avgCost: avg,
      currentCost: current,
      sigma: (current - avg) / stddev,
      stddev,
      windowDays: SPEND_SPIKE_WINDOW_DAYS,
    },
    severity: current > avg + SPEND_SPIKE_CRITICAL_SIGMA * stddev ? 'critical' : 'warn',
  };
}

async function evalHighErrorRate(db: AlertsDb): Promise<Evaluation> {
  const windowStart = new Date(Date.now() - ERROR_RATE_WINDOW_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ calls: number; errors: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(s.tool_call_count), 0) AS calls,
           COALESCE(SUM(s.tool_error_count), 0) AS errors
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${windowStart}
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const calls = Number(rows[0]?.calls ?? 0);
  const errors = Number(rows[0]?.errors ?? 0);
  if (calls < ERROR_RATE_MIN_CALLS || errors / calls <= ERROR_RATE_WARN) {
    return null;
  }
  return {
    details: { calls, errorRate: errors / calls, errors },
    severity: errors / calls > ERROR_RATE_CRITICAL ? 'critical' : 'warn',
  };
}

async function evalUnknownModelSurge(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const threshold = Number(paramsObject(params).threshold ?? UNKNOWN_MODEL_SURGE_DEFAULT);
  const windowStart = new Date(Date.now() - UNKNOWN_MODEL_WINDOW_HOURS * 3_600_000);
  // Visibility-scoped like the other evaluators: events from users who opted out
  // of org metadata sharing don't contribute to this org-aggregate signal.
  const rows = await db.$queryRaw<{ c: number }[]>(Prisma.sql`
    SELECT COUNT(*) AS c
    FROM events e
    JOIN users u ON u.id = e.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE e.ts >= ${windowStart}
      AND e.model IS NOT NULL
      AND e.cost_usd = 0
      AND e.input_tokens > 0
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const count = Number(rows[0]?.c ?? 0);
  if (count <= threshold) {
    return null;
  }
  return {
    details: { count, threshold, windowHours: UNKNOWN_MODEL_WINDOW_HOURS },
    severity: 'warn',
  };
}

async function evalBudgetThreshold(db: AlertsDb, params: unknown): Promise<Evaluation> {
  // Inert until an admin configures a positive budget. parseBudgetThresholdParams
  // returns null for a missing/invalid budget and coerces a malformed windowDays
  // back to the default (never NaN), so a misconfigured rule stays silent rather
  // than firing or silently never-matching on an Invalid Date window.
  const p = parseBudgetThresholdParams(params);
  if (!p) {
    return null;
  }
  const windowStart = new Date(Date.now() - p.windowDays * 86_400_000);
  // Visibility-scoped like the other evaluators: users who opted out of org
  // metadata sharing don't contribute to this org-aggregate spend signal.
  const rows = await db.$queryRaw<{ spend: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(s.total_cost_usd), 0) AS spend
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${windowStart}
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const spend = Number(rows[0]?.spend ?? 0);
  const ratio = spend / p.budgetUsd;
  if (ratio < BUDGET_THRESHOLD_WARN_RATIO) {
    return null;
  }
  return {
    details: { budgetUsd: p.budgetUsd, ratio, spend, windowDays: p.windowDays },
    severity: ratio >= BUDGET_THRESHOLD_CRITICAL_RATIO ? 'critical' : 'warn',
  };
}

// Autonomy surge (R9): the share of recent sessions running with no per-action
// human gate (bypass / dont_ask). A rising share is oversight erosion. Aggregate
// and visibility-scoped like the other evaluators — no individual is named.
async function evalAutonomySurge(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const warn = Number(paramsObject(params).threshold ?? AUTONOMY_SURGE_WARN);
  const critical = Number(paramsObject(params).criticalThreshold ?? AUTONOMY_SURGE_CRITICAL);
  const windowStart = new Date(Date.now() - AUTONOMY_SURGE_WINDOW_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ low_oversight: number; total: number }[]>(Prisma.sql`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE s.mode = ANY(${[...LOW_OVERSIGHT_MODES]}::text[])) AS low_oversight
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${windowStart}
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const total = Number(rows[0]?.total ?? 0);
  const lowOversight = Number(rows[0]?.low_oversight ?? 0);
  if (total < AUTONOMY_SURGE_MIN_SESSIONS) {
    return null;
  }
  const share = lowOversight / total;
  if (share <= warn) {
    return null;
  }
  return {
    details: {
      lowOversightSessions: lowOversight,
      share,
      totalSessions: total,
      windowDays: AUTONOMY_SURGE_WINDOW_DAYS,
    },
    severity: share > critical ? 'critical' : 'warn',
  };
}

async function evaluateRule(db: AlertsDb, rule: RuleRow): Promise<Evaluation> {
  switch (rule.ruleType) {
    case 'spend_spike':
      return evalSpendSpike(db);
    case 'high_error_rate':
      return evalHighErrorRate(db);
    case 'unknown_model_surge':
      return evalUnknownModelSurge(db, rule.params);
    case 'budget_threshold':
      return evalBudgetThreshold(db, rule.params);
    case 'autonomy_surge':
      return evalAutonomySurge(db, rule.params);
    default:
      // Any future types: unimplemented evaluators never fire rather than throwing,
      // so one bad rule can't fail the whole sweep.
      return null;
  }
}

/**
 * Scheduled alert evaluation (P9-001). Evaluates each enabled alert_rule against
 * the aggregates and records firing/resolving transitions in alert_events. Uses
 * the same statistical thresholds as the dashboard's getAnomalies (shared via
 * @ai-agents-observability/schemas) so banners and alerts never disagree.
 */
export async function runEvaluateAlerts(
  db: AlertsDb,
  logger?: Logger,
  appBaseUrl = '',
  emailConfig?: EmailConfig,
): Promise<void> {
  const jobName = 'evaluate-alerts';
  const startedAt = new Date();

  const lock = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;
  if (!lock[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({ data: { jobName, startedAt, status: 'running' } });
    jobRunId = jobRun.id;

    const rules = (await db.alertRule.findMany({ where: { enabled: true } })) as RuleRow[];
    // Load notification channels once; only newly-FIRED transitions notify (no
    // spam on still-firing or resolved). Delivery is best-effort and never throws.
    const channels = await db.alertChannelConfig.findMany({ where: { enabled: true } });
    let fired = 0;
    let resolved = 0;
    for (const rule of rules) {
      try {
        const evaluation = await evaluateRule(db, rule);
        const outcome = await applyAlertTransition(db, rule.id, evaluation);
        if (outcome === 'fired') {
          fired++;
          if (evaluation && channels.length > 0) {
            const payload = buildAlertPayload(
              rule,
              { details: evaluation.details, firedAt: new Date(), severity: evaluation.severity },
              appBaseUrl,
            );
            await dispatchAlert(db, channels, payload, { emailConfig, logger });
          }
        } else if (outcome === 'resolved') {
          resolved++;
        }
      } catch (err) {
        logger?.warn({ err, ruleId: rule.id }, 'Alert rule evaluation failed');
      }
    }

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });
    logger?.info({ fired, jobName, resolved, rules: rules.length }, 'Alert evaluation complete');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Alert evaluation failed');
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
