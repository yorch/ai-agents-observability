import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import {
  type AttributionEvent,
  type AttributionRow,
  computeSessionAttribution,
  type PriceLookup,
} from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';

import { resolveModelPrice } from '../lib/cost';
import { type EventChunk, listEventChunks, withDecompressedChunk } from '../lib/hypertable-chunks';
import type { PriceTableRegistry } from '../lib/price-tables';
import { type JobRunDb, withJobRun } from './job-run';

/**
 * Writes `events.attributed_cost_usd` and `events.downstream_cost_usd` — the two
 * turn-linked cost attributions defined in
 * `packages/schemas/src/cost-attribution.ts` (P14-004). The arithmetic lives
 * there, not here, because `packages/db/src/seed.ts` writes the same two
 * columns for the demo database and cannot depend on this app (P14-011) —
 * a seed that recomputed them locally is the exact defect Phase 14 removes.
 *
 * **The two columns are two lenses on the same dollars, not two costs. Never sum
 * them.** And nothing in this job touches `sessions.total_cost_usd`,
 * `pr_rollups.total_cost_usd` or the three continuous aggregates: that chain
 * already counts these dollars once, at the Stop event. `reprice-events` is the
 * job that has to move all four together; this one deliberately joins none of it.
 * `test/compute-cost-attribution.test.ts` asserts the job issues no write
 * against them.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * 1. Pick **settled** sessions (`ended_at IS NOT NULL`) that ended inside the
 *    lookback window. A session still receiving events has an incomplete final
 *    turn, and attributing an incomplete turn means dividing by the wrong number
 *    of tools.
 * 2. Read those sessions' events and compute both attributions in-process, so
 *    the arithmetic is a plain function with tests rather than a SQL expression
 *    nothing can exercise without a database.
 * 3. Write the results back one hypertable chunk at a time, decompressing only
 *    the chunks that are compressed (`lib/hypertable-chunks.ts`).
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * `computeSessionAttribution` is a pure function of the stored rows, and the
 * write is an assignment, never an accumulation. Running the job twice produces
 * the same numbers; the `IS DISTINCT FROM` guard means the second run writes no
 * rows at all. That is why this job — unlike `reprice-events` — needs no
 * report/apply interlock: it cannot destroy a number that was measured, only
 * recompute one it derived.
 */

export type CostAttributionDb = JobRunDb & {
  $executeRaw: PrismaClient['$executeRaw'];
};

/**
 * How far back a scheduled run looks, by `sessions.ended_at`.
 *
 * Seven days matches the `events` compression policy, so the nightly run
 * ordinarily rewrites only uncompressed chunks and never pays for a
 * decompress/recompress cycle. A wider backfill is a matter of passing a larger
 * `lookbackDays` from an operator script — re-running over already-attributed
 * sessions is free.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

/** Sessions per event fetch. Bounds the working set, not the result. */
const SESSION_BATCH = 100;

/** Rows per UPDATE … FROM (VALUES …). Bounds the statement, not the run. */
const WRITE_BATCH = 500;

type SessionRow = { ended_at: Date; session_id: string; started_at: Date };

type EventRow = {
  agent_type: string;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  // `::text` in the SELECT below: a NUMERIC comes back as a driver-specific
  // decimal object, and Number(String(x)) is the one conversion that is exact
  // for every driver.
  cost_usd: string | null;
  event_id: string;
  event_type: string;
  input_tokens: number | null;
  model: string | null;
  session_id: string;
  tool_output_bytes: number | null;
  ts: Date;
  turn_number: number | null;
};

export type CostAttributionOpts = {
  logger?: Logger | undefined;
  /** Defaults to {@link DEFAULT_LOOKBACK_DAYS}. */
  lookbackDays?: number;
  /** Defaults to `new Date()`. Injectable so tests are not clock-dependent. */
  now?: Date;
};

/**
 * Settled sessions that ended inside the window.
 *
 * run-kind-exempt: this job operates on rows, not on people — the same class as
 * `reprice-events` and the retention sweeps (`lib/run-kind.ts`, class 1). A CI
 * session's tool calls have an issuing turn exactly like anyone else's, and
 * skipping them would leave those rows permanently unattributed with nothing to
 * revisit them. Every human-facing read of these columns goes through
 * `interactive_events` in `apps/web`, so the guard is applied where the numbers
 * become a dashboard.
 */
async function settledSessions(db: CostAttributionDb, since: Date): Promise<SessionRow[]> {
  return db.$queryRaw<SessionRow[]>(Prisma.sql`
    SELECT session_id, started_at, ended_at
    FROM sessions
    WHERE ended_at IS NOT NULL
      AND ended_at >= ${since}
    ORDER BY ended_at
  `);
}

/**
 * Every turn-linked event for a batch of sessions.
 *
 * Bounded below by the batch's earliest `started_at` so Timescale can exclude
 * chunks; a session's own events cannot predate it. `turn_number IS NOT NULL`
 * does the degrading: a session ingested before the hook reported turn linkage
 * returns nothing here and is attributed nothing, rather than attributed wrongly.
 *
 * run-kind-exempt: see `settledSessions` above — the population is already fixed
 * by the session batch this is called with, and the job is a row-operation.
 */
async function turnLinkedEvents(
  db: CostAttributionDb,
  sessions: SessionRow[],
): Promise<Map<string, AttributionEvent[]>> {
  const earliest = sessions.reduce(
    (min, s) => (s.started_at < min ? s.started_at : min),
    sessions[0]?.started_at ?? new Date(0),
  );
  const ids = Prisma.join(sessions.map((s) => Prisma.sql`${s.session_id}::uuid`));

  const rows = await db.$queryRaw<EventRow[]>(Prisma.sql`
    SELECT
      session_id, event_id, ts, event_type, turn_number, agent_type,
      tool_output_bytes, model, cost_usd::text AS cost_usd,
      input_tokens, cache_read_tokens, cache_creation_tokens
    -- run-kind-exempt: a row-operation, like reprice-events. The population is
    -- already fixed by the session batch this is called with, and a CI session's
    -- tool calls have an issuing turn exactly like anyone else's. The guard is
    -- applied where these columns become a dashboard: apps/web reads them
    -- through interactive_events.
    FROM events
    WHERE session_id IN (${ids})
      AND ts >= ${earliest}
      AND turn_number IS NOT NULL
    ORDER BY session_id, ts
  `);

  const bySession = new Map<string, AttributionEvent[]>();
  for (const r of rows) {
    const list = bySession.get(r.session_id) ?? [];
    list.push({
      agentType: r.agent_type,
      cacheCreationTokens: r.cache_creation_tokens,
      cacheReadTokens: r.cache_read_tokens,
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      eventId: r.event_id,
      eventType: r.event_type,
      inputTokens: r.input_tokens,
      model: r.model,
      toolOutputBytes: r.tool_output_bytes,
      ts: r.ts,
      turnNumber: r.turn_number,
    });
    bySession.set(r.session_id, list);
  }
  return bySession;
}

/** Which chunk a timestamp falls in. Rows outside every chunk cannot be written. */
function bucketByChunk(
  rows: AttributionRow[],
  chunks: EventChunk[],
): Map<EventChunk, AttributionRow[]> {
  const buckets = new Map<EventChunk, AttributionRow[]>();
  for (const row of rows) {
    const chunk = chunks.find((c) => row.ts >= c.rangeStart && row.ts < c.rangeEnd);
    if (!chunk) {
      continue;
    }
    const list = buckets.get(chunk) ?? [];
    list.push(row);
    buckets.set(chunk, list);
  }
  return buckets;
}

/**
 * Write one batch of computed rows.
 *
 * Values go over as text and are cast in-database: a NUMERIC(12,6) round-tripped
 * through a JS double would occasionally land a half-ulp away from the stored
 * value and defeat the `IS DISTINCT FROM` guard, turning every run into a full
 * rewrite. The chunk's time range is repeated in the predicate because a `ts`
 * bound is what Timescale's chunk exclusion understands.
 *
 * run-kind-exempt: see `settledSessions` — this writes a derived column onto
 * rows, and a CI session's rows need it written exactly like an interactive
 * session's.
 */
async function writeBatch(
  db: CostAttributionDb,
  chunk: EventChunk,
  rows: AttributionRow[],
): Promise<number> {
  const values = Prisma.join(
    rows.map(
      (r) => Prisma.sql`(
        ${r.eventId}::uuid,
        ${r.ts}::timestamptz,
        ${r.attributedCostUsd === null ? null : r.attributedCostUsd.toFixed(6)}::numeric,
        ${r.downstreamCostUsd === null ? null : r.downstreamCostUsd.toFixed(6)}::numeric
      )`,
    ),
    ',',
  );

  return db.$executeRaw(Prisma.sql`
    -- run-kind-exempt: writes a derived column onto rows, not a report about
    -- people. A CI session's rows need it written exactly like an interactive
    -- session's, and skipping them would leave them permanently unattributed
    -- with nothing to revisit them.
    UPDATE events e
    SET attributed_cost_usd = v.attributed,
        downstream_cost_usd = v.downstream
    FROM (VALUES ${values}) AS v(event_id, ts, attributed, downstream)
    WHERE e.event_id = v.event_id
      AND e.ts = v.ts
      AND e.ts >= ${chunk.rangeStart}
      AND e.ts <  ${chunk.rangeEnd}
      AND (e.attributed_cost_usd IS DISTINCT FROM v.attributed
        OR e.downstream_cost_usd IS DISTINCT FROM v.downstream)
  `);
}

export async function runComputeCostAttribution(
  db: CostAttributionDb,
  registry: PriceTableRegistry,
  opts: CostAttributionOpts = {},
): Promise<void> {
  const logger = opts.logger;
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1_000);

  await withJobRun(db, 'compute-cost-attribution', logger, async () => {
    const sessions = await settledSessions(db, since);
    if (sessions.length === 0) {
      logger?.info({ lookbackDays }, 'cost-attribution: no settled sessions in window');
      return;
    }

    // Resolution goes through `resolveModelPrice` — the same lookup ingest uses,
    // including its `<provider>/` prefix fallback — so the downstream half is
    // priced identically to the cost it is redistributing.
    const priceFor: PriceLookup = (agentType, model) =>
      resolveModelPrice(model, registry.resolve(agentType));

    const computed: AttributionRow[] = [];
    let attributedSessions = 0;
    for (let i = 0; i < sessions.length; i += SESSION_BATCH) {
      const batch = sessions.slice(i, i + SESSION_BATCH);
      const bySession = await turnLinkedEvents(db, batch);
      for (const events of bySession.values()) {
        const rows = computeSessionAttribution(events, priceFor);
        if (rows.length > 0) {
          attributedSessions += 1;
          computed.push(...rows);
        }
      }
    }

    if (computed.length === 0) {
      logger?.info(
        { lookbackDays, sessions: sessions.length },
        'cost-attribution: no turn linkage in window — nothing attributed',
      );
      return;
    }

    const chunks = await listEventChunks(db, since);
    const buckets = bucketByChunk(computed, chunks);

    let updated = 0;
    for (const [chunk, rows] of buckets) {
      updated += await withDecompressedChunk(db, chunk, async () => {
        let n = 0;
        for (let i = 0; i < rows.length; i += WRITE_BATCH) {
          n += await writeBatch(db, chunk, rows.slice(i, i + WRITE_BATCH));
        }
        return n;
      });
    }

    logger?.info(
      {
        attributedSessions,
        chunks: buckets.size,
        rows: computed.length,
        sessions: sessions.length,
        updated,
      },
      'cost-attribution: applied',
    );
  });
}
