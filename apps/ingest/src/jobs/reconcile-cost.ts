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

/**
 * Fans one lookup out across several vendor sources and takes the first that
 * answers. Each source already returns `null` for agent types it does not bill
 * (Anthropic for anything but `CLAUDE_CODE`, GitHub for anything but `COPILOT`),
 * so "first non-null wins" needs no per-agent routing table here — and two
 * sources claiming the same agent would be a wiring mistake, not something to
 * resolve by summing.
 */
export class CompositeBillingSource implements BillingSource {
  private readonly sources: readonly BillingSource[];

  constructor(sources: readonly BillingSource[]) {
    this.sources = sources;
  }

  async fetchBilledCost(agentType: string, year: number, month: number): Promise<number | null> {
    for (const source of this.sources) {
      const cost = await source.fetchBilledCost(agentType, year, month);
      if (cost != null) {
        return cost;
      }
    }
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
 *
 * It records drift; it never writes cost. `events.cost_usd` and the session /
 * PR / continuous-aggregate chain that accumulates from it are corrected only by
 * `reprice-events`, deliberately and by operator trigger.
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

    // run-kind-exempt: this sums client-computed cost to compare against the
    // vendor's own monthly bill. The vendor bills every token the account
    // sends it, CI and eval runs included -- there is no "interactive only"
    // line item on their invoice -- so excluding non-interactive events here
    // would manufacture a permanent drift against a number that was never
    // supposed to match in the first place.
    const rows = await db.$queryRaw<
      { agent_type: string; client_cost: number | string; client_tokens: number | string }[]
    >(
      Prisma.sql`
        SELECT
          agent_type,
          COALESCE(SUM(cost_usd), 0) AS client_cost,
          COALESCE(SUM(
            COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
            + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)
          ), 0) AS client_tokens
        -- run-kind-exempt: compared against a vendor invoice that bills every
        -- token the account sent, CI and eval runs included.
        FROM events
        WHERE ts >= ${monthStart} AND ts < ${monthEnd}
        GROUP BY agent_type
      `,
    );

    for (const row of rows) {
      const clientCost = Number(row.client_cost);
      const clientTokens = Number(row.client_tokens);
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

      // The vendor billed for this month and not one event we stored carried a
      // token count. `SUM(cost_usd)` is then structurally zero — cost is derived
      // from tokens (`lib/cost.ts`), so with no tokens there is no priced
      // measurement to be wrong. The drift here is the size of our capture gap,
      // not the size of a pricing error, and the two must not share an alert:
      // `COPILOT` is in exactly this state today (P14-007 — no Copilot hook
      // payload carries tokens or a model), so counting it as a breach would
      // fire a pricing alert every month for a hook that is working as built.
      // Gauges are still set — the delta is real money, and hiding it would be
      // its own dishonesty — but the *breach counter*, which is what an operator
      // pages on, is not incremented.
      if (vendorCost > 0 && clientTokens === 0) {
        logger?.warn(
          { agentType: row.agent_type, clientCost, driftRatio, month, vendorCost, year },
          'cost.reconciliation.no_client_token_coverage',
        );
        continue;
      }

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
