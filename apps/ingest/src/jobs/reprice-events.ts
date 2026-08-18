import type { PrismaClient } from '@ai-agents-observability/db';
import { computePRRollup, Prisma } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

import { resolveModelPrice } from '../lib/cost';
import type { PriceTableRegistry } from '../lib/price-tables';
import { type JobRunDb, withJobRun } from './job-run';

export type RepriceDb = JobRunDb &
  Pick<PrismaClient, 'sessionPRLink' | 'session' | 'pRRollup' | 'pullRequest'> & {
    $executeRaw: PrismaClient['$executeRaw'];
    $executeRawUnsafe: PrismaClient['$executeRawUnsafe'];
  };

/**
 * `events.cost_usd` is computed once, at ingest, from the price table current at
 * that moment. When a table is corrected — a rate was wrong, or a model was
 * missing and billed $0 — history keeps the old number. This job recomputes it
 * from the token counts already stored on each row.
 *
 * It is deliberately **not scheduled**. Rewriting historical cost is an operator
 * decision, and the two job names are the safety interlock: `reprice-events`
 * only ever reports, `reprice-events-apply` writes. The manual-trigger endpoint
 * takes no request body, so a flag would have had nowhere to live — and a
 * destructive default is worse than two names.
 *
 * Four things have to move together or the dashboards disagree with each other:
 *
 *   events.cost_usd  →  sessions.total_cost_usd  →  pr_rollups.total_cost_usd
 *                    →  daily_cost_by_user / daily_cost_by_model
 *
 * `sessions.total_cost_usd` is *accumulated* at ingest (`total_cost_usd +
 * EXCLUDED.total_cost_usd`), never recomputed, so it cannot be left to drift
 * back into agreement on its own. Same for the PR rollups, which are derived
 * from the session totals at merge/link time.
 */

type ModelRate = {
  agentType: string;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  model: string;
  output: number;
};

/** One row of the dry-run report: what repricing would do to one model. */
export type RepricePlanRow = {
  agentType: string;
  deltaUsd: number;
  events: number;
  model: string;
  newCostUsd: number;
  oldCostUsd: number;
};

export type RepricePlan = {
  rows: RepricePlanRow[];
  /** (agent, model) pairs with events but no price row — they stay at $0. */
  unpriced: { agentType: string; events: number; model: string }[];
};

type ChunkRow = {
  chunk_name: string;
  chunk_schema: string;
  is_compressed: boolean;
  range_end: Date;
  range_start: Date;
};

type PairRow = { agent_type: string; events: number | string; model: string };

// The cost expression, shared by the report and the UPDATE so the two can never
// disagree about what "new cost" means. NUMERIC throughout: Postgres does exact
// decimal arithmetic, where the ingest path goes through a JS double first. That
// makes a repriced row occasionally differ from a freshly-ingested one in the
// last of the six stored decimal places — in favour of this one.
const NEW_COST = Prisma.sql`
  ROUND((
      COALESCE(e.input_tokens, 0)          * r.input
    + COALESCE(e.output_tokens, 0)         * r.output
    + COALESCE(e.cache_read_tokens, 0)     * r.cache_read
    + COALESCE(e.cache_creation_tokens, 0) * r.cache_write
  ) / 1000000.0, 6)
`;

/** Builds the `(agent_type, model, rates…)` VALUES list the queries join against. */
function ratesCte(rates: ModelRate[]): Prisma.Sql {
  return Prisma.sql`
    rates (agent_type, model, input, output, cache_read, cache_write) AS (
      VALUES ${Prisma.join(
        rates.map(
          (r) => Prisma.sql`(
            ${r.agentType}::text,
            ${r.model}::text,
            ${r.input}::numeric,
            ${r.output}::numeric,
            ${r.cacheRead}::numeric,
            ${r.cacheWrite}::numeric
          )`,
        ),
        ',',
      )}
    )
  `;
}

/**
 * Resolve every `(agent_type, model)` pair actually present in `events` against
 * the *current* price tables. Pairs with no price are reported, not priced — the
 * P8-002 rule holds here too: an unpriced model bills $0 rather than being
 * guessed at. Resolution goes through `resolveModelPrice` so the job and the
 * ingest path agree, including the `<provider>/` prefix fallback.
 */
async function resolveRates(
  db: RepriceDb,
  registry: PriceTableRegistry,
): Promise<{ rates: ModelRate[]; unpriced: RepricePlan['unpriced'] }> {
  // run-kind-exempt: repricing corrects a number already stored on a row, keyed
  // by (agent_type, model). A CI run's cost_usd is wrong in exactly the same way
  // an interactive one's is, and nothing else would ever revisit it. Every
  // human-facing read stays clean downstream — interactive_sessions /
  // interactive_events, and both cost caggs are themselves filtered.
  const pairs = await db.$queryRaw<PairRow[]>(Prisma.sql`
    SELECT agent_type, model, COUNT(*) AS events
    FROM events
    WHERE model IS NOT NULL AND model <> ''
    GROUP BY agent_type, model
  `);

  const rates: ModelRate[] = [];
  const unpriced: RepricePlan['unpriced'] = [];
  for (const pair of pairs) {
    const price = resolveModelPrice(pair.model, registry.resolve(pair.agent_type));
    if (!price) {
      unpriced.push({
        agentType: pair.agent_type,
        events: Number(pair.events),
        model: pair.model,
      });
      continue;
    }
    rates.push({
      agentType: pair.agent_type,
      cacheRead: price.cache_read_per_mtok,
      cacheWrite: price.cache_write_per_mtok,
      input: price.input_per_mtok,
      model: pair.model,
      output: price.output_per_mtok,
    });
  }
  return { rates, unpriced };
}

/** What would change, per model. Reads only — safe to run against live data. */
export async function planReprice(
  db: RepriceDb,
  registry: PriceTableRegistry,
): Promise<RepricePlan> {
  const { rates, unpriced } = await resolveRates(db, registry);
  if (rates.length === 0) {
    return { rows: [], unpriced };
  }

  const rows = await db.$queryRaw<
    {
      agent_type: string;
      events: number | string;
      model: string;
      new_cost: number | string;
      old_cost: number | string;
    }[]
  >(Prisma.sql`
    WITH ${ratesCte(rates)}
    -- run-kind-exempt: same reasoning as resolveRates above -- this plans the
    -- repriced delta across every event regardless of run kind, since a CI
    -- run's stored cost_usd is wrong in exactly the same way an interactive
    -- one's is, and repriceSessionTotals below must recompute from this same
    -- unfiltered population or the two would disagree.
    SELECT
      e.agent_type,
      e.model,
      COUNT(*)                          AS events,
      COALESCE(SUM(e.cost_usd), 0)      AS old_cost,
      COALESCE(SUM(${NEW_COST}), 0)     AS new_cost
    FROM events e
    JOIN rates r ON r.agent_type = e.agent_type AND r.model = e.model
    GROUP BY e.agent_type, e.model
    HAVING COALESCE(SUM(e.cost_usd), 0) IS DISTINCT FROM COALESCE(SUM(${NEW_COST}), 0)
    ORDER BY ABS(COALESCE(SUM(${NEW_COST}), 0) - COALESCE(SUM(e.cost_usd), 0)) DESC
  `);

  return {
    rows: rows.map((r) => {
      const oldCostUsd = Number(r.old_cost);
      const newCostUsd = Number(r.new_cost);
      return {
        agentType: r.agent_type,
        deltaUsd: newCostUsd - oldCostUsd,
        events: Number(r.events),
        model: r.model,
        newCostUsd,
        oldCostUsd,
      };
    }),
    unpriced,
  };
}

/**
 * Rewrite `events.cost_usd`, one hypertable chunk at a time.
 *
 * `events` is compressed after 7 days, so most of the history this job exists to
 * fix lives in compressed chunks. Rather than rely on DML-over-compressed-data,
 * each affected chunk is decompressed, updated, and recompressed — and only
 * recompressed if it *was* compressed, so a chunk the policy has not reached yet
 * is not compressed early as a side effect.
 *
 * Chunk identifiers come from `timescaledb_information.chunks` and are quoted
 * with `format('%I.%I', …)` in-database, so they never round-trip through string
 * interpolation here. The UPDATE itself is scoped by the chunk's *time range*
 * rather than by `tableoid`: a `ts` predicate is what Timescale's chunk
 * exclusion understands, so each statement touches one chunk instead of
 * scanning the whole hypertable once per chunk.
 */
async function repriceEventRows(
  db: RepriceDb,
  rates: ModelRate[],
  logger: Logger | undefined,
): Promise<number> {
  const chunks = await db.$queryRaw<ChunkRow[]>(Prisma.sql`
    SELECT chunk_schema, chunk_name, is_compressed, range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'events'
    ORDER BY range_start
  `);

  let updated = 0;
  for (const chunk of chunks) {
    // The ::text casts are load-bearing: without them Postgres cannot infer a
    // bare parameter's type inside format() and rejects the statement with
    // 42P18 "could not determine data type of parameter $1".
    const target = Prisma.sql`
      format('%I.%I', ${chunk.chunk_schema}::text, ${chunk.chunk_name}::text)::regclass
    `;
    if (chunk.is_compressed) {
      // ::text on the result too — decompress_chunk returns regclass, which the
      // Prisma driver cannot decode (UnsupportedNativeDataType).
      await db.$queryRaw(Prisma.sql`SELECT decompress_chunk(${target})::text`);
    }
    try {
      // `IS DISTINCT FROM` keeps this to the rows whose cost actually moves, so
      // a re-run after a partial failure rewrites nothing it already fixed.
      // run-kind-exempt: see resolveRates. Repricing is all-or-nothing across
      // run kinds for the same reason it is all-or-nothing across time.
      const n = await db.$executeRaw(Prisma.sql`
        WITH ${ratesCte(rates)}
        UPDATE events e
        SET cost_usd = ${NEW_COST}
        FROM rates r
        WHERE r.agent_type = e.agent_type
          AND r.model = e.model
          AND e.ts >= ${chunk.range_start}
          AND e.ts <  ${chunk.range_end}
          AND e.cost_usd IS DISTINCT FROM ${NEW_COST}
      `);
      updated += n;
    } finally {
      if (chunk.is_compressed) {
        await db.$queryRaw(Prisma.sql`SELECT compress_chunk(${target})::text`);
      }
    }
  }

  logger?.info({ chunks: chunks.length, updated }, 'reprice: events rewritten');
  return updated;
}

/**
 * Recompute `sessions.total_cost_usd` from the (now corrected) events.
 *
 * Deliberately unwindowed. Repricing a *slice* of history would leave any
 * session straddling the boundary with a total summed from a mix of old and new
 * rates — silently wrong in a way nothing downstream would catch. Repricing is
 * all-or-nothing for that reason, and this recompute reads every event.
 */
async function repriceSessionTotals(db: RepriceDb, logger: Logger | undefined): Promise<number> {
  // run-kind-exempt: this must match what the UPDATE above wrote. Filtering the
  // recompute while the event reprice ran unfiltered would desynchronize
  // sessions.total_cost_usd from events.cost_usd for every non-interactive
  // session — the exact drift this job exists to remove.
  const n = await db.$executeRaw(Prisma.sql`
    UPDATE sessions s
    SET total_cost_usd = agg.total
    FROM (
      SELECT session_id, COALESCE(SUM(cost_usd), 0) AS total
      FROM events
      GROUP BY session_id
    ) agg
    WHERE s.session_id = agg.session_id
      AND s.total_cost_usd IS DISTINCT FROM agg.total
  `);
  logger?.info({ sessions: n }, 'reprice: session totals recomputed');
  return n;
}

/**
 * Recompute every PR rollup that has linked sessions, through the same
 * `computePRRollup` the webhook and the manual link action use — so a repriced
 * rollup is byte-identical to one the normal path would have written.
 */
async function repricePrRollups(db: RepriceDb, logger: Logger | undefined): Promise<number> {
  const prs = await db.$queryRaw<{ pr_number: number; repo_id: string }[]>(Prisma.sql`
    SELECT DISTINCT repo_id, pr_number FROM session_pr_links
  `);
  let n = 0;
  for (const pr of prs) {
    try {
      await computePRRollup(db, pr.repo_id, pr.pr_number);
      n += 1;
    } catch (err) {
      // One unrollable PR (a deleted repo row, a half-linked session) must not
      // abandon the rest — the events and session totals are already correct.
      logger?.warn({ err, prNumber: pr.pr_number, repoId: pr.repo_id }, 'reprice: rollup failed');
    }
  }
  logger?.info({ pullRequests: n }, 'reprice: PR rollups recomputed');
  return n;
}

// The two cost-bearing continuous aggregates. daily_tool_usage carries no cost
// column, so repricing cannot affect it.
const COST_CAGGS = ['daily_cost_by_user', 'daily_cost_by_model'] as const;

/**
 * Refresh the cost aggregates over their whole range.
 *
 * Their refresh policies only reach back 32 days, so without this the org
 * dashboards would keep serving pre-reprice numbers for everything older —
 * indefinitely, since the policy never revisits those buckets. `CALL` is used
 * (not SELECT) and cannot run inside a transaction block, which is why this
 * goes through `$executeRawUnsafe` on the plain connection.
 */
async function refreshCostAggregates(db: RepriceDb, logger: Logger | undefined): Promise<void> {
  for (const cagg of COST_CAGGS) {
    // cagg is from the const list above, never user input.
    await db.$executeRawUnsafe(`CALL refresh_continuous_aggregate('${cagg}', NULL, NULL)`);
  }
  logger?.info({ caggs: COST_CAGGS.length }, 'reprice: cost aggregates refreshed');
}

export type RepriceOpts = {
  /** false (the default) reports only. True rewrites history. */
  apply?: boolean;
  logger?: Logger | undefined;
};

export async function runRepriceEvents(
  db: RepriceDb,
  registry: PriceTableRegistry,
  opts: RepriceOpts = {},
): Promise<void> {
  const apply = opts.apply === true;
  const logger = opts.logger;
  // withJobRun derives its advisory lock from the job name, so the two names take
  // *different* locks: two applies cannot overlap (same name), but a report run
  // during an apply will describe a partly repriced table. That is the intended
  // order anyway — report, then apply.
  await withJobRun(db, apply ? 'reprice-events-apply' : 'reprice-events', logger, async () => {
    const plan = await planReprice(db, registry);

    for (const row of plan.rows) {
      logger?.info(
        {
          agentType: row.agentType,
          deltaUsd: Number(row.deltaUsd.toFixed(6)),
          events: row.events,
          model: row.model,
          newCostUsd: Number(row.newCostUsd.toFixed(6)),
          oldCostUsd: Number(row.oldCostUsd.toFixed(6)),
        },
        'reprice.model',
      );
    }
    for (const row of plan.unpriced) {
      logger?.warn(
        { agentType: row.agentType, events: row.events, model: row.model },
        'reprice.unpriced_model',
      );
    }

    const deltaUsd = plan.rows.reduce((sum, r) => sum + r.deltaUsd, 0);
    const events = plan.rows.reduce((sum, r) => sum + r.events, 0);

    if (!apply) {
      logger?.info(
        {
          deltaUsd: Number(deltaUsd.toFixed(6)),
          events,
          models: plan.rows.length,
          unpricedModels: plan.unpriced.length,
        },
        'reprice: dry run complete — trigger reprice-events-apply to write',
      );
      return;
    }

    if (plan.rows.length === 0) {
      logger?.info({ unpricedModels: plan.unpriced.length }, 'reprice: nothing to do');
      return;
    }

    const { rates } = await resolveRates(db, registry);
    await repriceEventRows(db, rates, logger);
    await repriceSessionTotals(db, logger);
    await repricePrRollups(db, logger);
    await refreshCostAggregates(db, logger);

    logger?.info(
      { deltaUsd: Number(deltaUsd.toFixed(6)), events, models: plan.rows.length },
      'reprice: applied',
    );
  });
}
