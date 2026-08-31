import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

import { type JobRunDb, withJobRun } from './job-run';

// withJobRun's surface plus the raw path the CALL goes through. Deliberately
// NOT JobRawDb: this job must never see `$transaction`, because
// `refresh_continuous_aggregate` does its own transaction control and errors
// out if it is called inside one.
export type RefreshCaggsDb = JobRunDb & {
  $executeRawUnsafe: PrismaClient['$executeRawUnsafe'];
};

/**
 * The three continuous aggregates declared in
 * `packages/db/sql/migrations/0001_init.sql`. Hardcoded rather than discovered
 * from `timescaledb_information.continuous_aggregates` so that a new aggregate
 * is a deliberate edit here — and because these names are interpolated into the
 * CALL below, which is only safe while they are compile-time constants.
 */
export const REFRESHED_CAGGS = [
  'daily_cost_by_user',
  'daily_cost_by_model',
  'daily_tool_usage',
] as const;

/** Midnight UTC on the day `now` falls in. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Re-materialize the continuous aggregates over the whole of history.
 *
 * **Why this job exists.** Each aggregate carries
 * `add_continuous_aggregate_policy(..., start_offset => INTERVAL '32 days')`,
 * so the background policy only ever refreshes the trailing 32 days. That is
 * correct for live telemetry, which always arrives at `now`, and wrong for
 * every other way rows reach the hypertable:
 *
 *  - **Imports.** `apps/hook`'s `import` command preserves each transcript's
 *    original timestamps, so a bulk import lands events *months or years* in
 *    the past. The policy never reaches them, and because the aggregates are
 *    `materialized_only = false`, real-time aggregation does not rescue them
 *    either: it unions live rows only for the region *after* the materialization
 *    watermark, never before it. Imported history is simply invisible to every
 *    cagg-backed query until something refreshes it.
 *  - **Re-imports and late arrivals.** Writing into a region that *is* already
 *    materialized records a TimescaleDB invalidation instead, which the same
 *    32-day policy will never process if the region is older than that.
 *
 * **Why it refreshes everything rather than detecting a gap.** Refreshing a
 * range that is already current is driven off the invalidation log, so clean
 * buckets are skipped: measured against ~900k events, the first full-history
 * refresh took 6.6s and an immediate repeat took 85ms. Unconditional beats
 * clever here — a gap check on `min(day)` would extend the materialized range
 * downwards but silently miss the second case above, where the range is right
 * and the contents are stale. A NULL lower bound means "the beginning of time",
 * which also avoids racing an import that is still inserting older rows.
 *
 * The window ends at midnight UTC so only *complete* day buckets are
 * materialized; today's bucket is left to the hourly policy and to real-time
 * aggregation, which would otherwise serve a partially-materialized today until
 * the next run. Overlapping the policy's own 32 days costs nothing (see the
 * timings above) and removes any need to keep a constant here in sync with
 * `start_offset` in the migration.
 */
export async function runRefreshCaggs(
  db: RefreshCaggsDb,
  logger?: Logger,
  now: Date = new Date(),
): Promise<void> {
  await withJobRun(db, 'refresh-caggs', logger, async () => {
    const end = startOfUtcDay(now).toISOString();

    for (const cagg of REFRESHED_CAGGS) {
      const startedAt = Date.now();
      // Interpolated, not parameterized: `cagg` is a compile-time constant from
      // REFRESHED_CAGGS and `end` is an ISO string off a Date, so neither is
      // user input. `refresh_continuous_aggregate` also cannot run inside the
      // implicit transaction a parameterized statement would imply.
      await db.$executeRawUnsafe(`CALL refresh_continuous_aggregate('${cagg}', NULL, '${end}')`);
      logger?.info(
        { cagg, durationMs: Date.now() - startedAt, through: end },
        'refresh-caggs: refreshed continuous aggregate',
      );
    }
  });
}
