import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

import {
  costReconciliationDeltaUsd,
  costReconciliationDriftRatio,
  costReconciliationThresholdExceededTotal,
} from '../lib/metrics';

type DbWithRaw = Pick<PrismaClient, 'jobRun'> & {
  $queryRaw: PrismaClient['$queryRaw'];
};

/**
 * Pluggable source of vendor-reported (ground-truth) cost. Keyed by
 * (agentType, year, month) so each agent's billing API plugs in without changing
 * the reconciliation logic. `null` means "no figure available" (the source isn't
 * configured for this agent/month) — reconciliation then records zero drift.
 *
 * The first real implementation (gated, P8-006 follow-up) is expected to be an
 * Anthropic admin/usage-API client for claude_code.
 */
export interface BillingSource {
  fetchBilledCost(agentType: string, year: number, month: number): Promise<number | null>;
}

/** Default no-op source: makes no vendor call. Lets the job + seam run in CI. */
export class NullBillingSource implements BillingSource {
  async fetchBilledCost(): Promise<number | null> {
    return null;
  }
}

export const DEFAULT_DRIFT_THRESHOLD = 0.05;

type ReconcileOpts = {
  driftThreshold?: number;
  logger?: Logger | undefined;
  // Injectable clock for tests; defaults to wall-clock.
  now?: Date;
};

/**
 * Reconcile client-computed cost (SUM of events.cost_usd) against vendor-billed
 * cost for the previous full calendar month, per agent_type. Emits delta + drift
 * gauges and counts threshold breaches. Idempotent: re-running re-sets the gauges
 * for the same month. Gated by BILLING_RECONCILIATION_ENABLED at the scheduler.
 */
export async function runReconcileCost(
  db: DbWithRaw,
  billingSource: BillingSource,
  opts: ReconcileOpts = {},
): Promise<void> {
  const jobName = 'reconcile-cost';
  const logger = opts.logger;
  const driftThreshold = opts.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
  // Single clock read — reused for both the jobRun timestamp and the month window
  // so they can't skew apart across the advisory-lock acquire.
  const ref = opts.now ?? new Date();
  const startedAt = ref;

  const lockResult = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;
  if (!lockResult[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await (db as Pick<PrismaClient, 'jobRun'>).jobRun.create({
      data: { jobName, startedAt, status: 'running' },
    });
    jobRunId = jobRun.id;

    // Previous full calendar month, in UTC.
    const monthStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
    const monthEnd = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    const year = monthStart.getUTCFullYear();
    const month = monthStart.getUTCMonth() + 1; // 1-based for billing APIs

    const rows = await db.$queryRaw<{ agent_type: string; client_cost: number | string }[]>(
      Prisma.sql`
        SELECT agent_type, COALESCE(SUM(cost_usd), 0) AS client_cost
        FROM events
        WHERE ts >= ${monthStart} AND ts < ${monthEnd}
        GROUP BY agent_type
      `,
    );

    for (const row of rows) {
      const clientCost = Number(row.client_cost);
      const vendorCost = await billingSource.fetchBilledCost(row.agent_type, year, month);

      if (vendorCost == null) {
        // No ground truth available (e.g. NullBillingSource) — nothing to compare.
        costReconciliationDeltaUsd.set({ agent_type: row.agent_type }, 0);
        costReconciliationDriftRatio.set({ agent_type: row.agent_type }, 0);
        continue;
      }

      const delta = clientCost - vendorCost;
      const driftRatio = vendorCost > 0 ? Math.abs(delta) / vendorCost : 0;
      costReconciliationDeltaUsd.set({ agent_type: row.agent_type }, delta);
      costReconciliationDriftRatio.set({ agent_type: row.agent_type }, driftRatio);

      if (driftRatio > driftThreshold) {
        costReconciliationThresholdExceededTotal.inc({ agent_type: row.agent_type });
        logger?.warn(
          { agentType: row.agent_type, clientCost, driftRatio, month, vendorCost, year },
          'cost.reconciliation.drift_exceeded',
        );
      }
    }

    await (db as Pick<PrismaClient, 'jobRun'>).jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });

    logger?.info({ agents: rows.length, jobName, month, year }, 'Cost reconciliation complete');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Cost reconciliation failed');
    if (jobRunId !== undefined) {
      await (db as Pick<PrismaClient, 'jobRun'>).jobRun
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
