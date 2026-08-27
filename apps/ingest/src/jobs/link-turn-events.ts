import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

import { type EventChunk, listEventChunks, withDecompressedChunk } from '../lib/hypertable-chunks';
import { linkageForSession, type StopTurn, type ToolEvent } from '../lib/turn-linkage';
import { type JobRunDb, withJobRun } from './job-run';

/**
 * Writes `events.turn_number` and `events.parent_event_id` onto LIVE tool events
 * that were captured without them (P14-006).
 *
 * ── Why these rows are unlinked in the first place ──────────────────────────
 *
 * P14-003 gave Claude Code real per-turn usage, and gave IMPORTED sessions full
 * turn linkage — but not live ones. Each tool hook is its own short-lived
 * process that fires BEFORE the `Stop` of the turn that issued it, so that
 * Stop's `event_id` does not exist yet; and the only place the linkage is
 * derivable is the session transcript, which `apps/hook/AGENTS.md` forbids a
 * tool-lifecycle hook from reading (`PreToolUse` fires orders of magnitude more
 * often than a terminal hook). So the linkage cannot be produced at capture
 * time, by anything, on that side of the wire.
 *
 * A timestamp-nearest-Stop heuristic was rejected twice before this task and is
 * still rejected: parallel tool calls, Claude Code's Stop firing once per
 * response *cycle* rather than per assistant *turn*, and skew between hook time
 * and assistant-message time each put a call in the wrong turn's divisor, and
 * the symptom is a plausible dollar figure on the wrong tool.
 *
 * ── What replaces it: a natural key, not an estimate ────────────────────────
 *
 * Claude Code's `PreToolUse`/`PostToolUse` payloads carry `tool_use_id`, and the
 * transcript repeats the SAME id on the `tool_use` block of the assistant turn
 * that issued the call. The Stop hook already reads those transcript lines (that
 * is where its token usage comes from), so it now also ships the ids each turn
 * issued, under `metadata.tool_use_ids`. Both halves are therefore already in
 * `events` by the time this job runs, and the join is exact:
 *
 *     tool row .tool_use_id  ==  some Stop row's metadata.tool_use_ids[i]
 *       -> tool.turn_number     = that Stop's turn_number
 *       -> tool.parent_event_id = that Stop's event_id
 *
 * which is the P14-004 contract verbatim, and the SAME contract the import path
 * writes inline. No clock is consulted and no ordering is assumed; a call whose
 * issuing turn is not present stays NULL — "not attributed", never `$0.00`.
 *
 * ── Why a job, and not the ingest request path ──────────────────────────────
 *
 * Doing the UPDATE inline when a Stop arrives would usually work — tool hooks
 * fire before the Stop and the queue is FIFO — but "usually" is the wrong
 * guarantee for money, and a tool row that arrived late would stay unlinked
 * forever with nothing to revisit it. A job over settled sessions is
 * order-independent, idempotent, and self-healing. It also inherits the
 * compressed-chunk handling every other column-rewriting job needs
 * (`lib/hypertable-chunks.ts`), which an inline UPDATE would have to duplicate.
 *
 * Timeliness costs nothing here: the only consumer is
 * `compute-cost-attribution`, itself a nightly job over sessions that have
 * already ended. This one is scheduled immediately before it.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 *
 * `linkageForSession` is a pure function of the stored rows, and the write is an
 * assignment guarded by `turn_number IS NULL`, so a second run writes nothing.
 * Already-linked rows — every imported one — are never selected, so this job can
 * never overwrite a linkage that was captured rather than derived.
 */

export type TurnLinkageDb = JobRunDb & {
  $executeRaw: PrismaClient['$executeRaw'];
};

/**
 * How far back a scheduled run looks, by `sessions.ended_at`.
 *
 * Seven days matches both the `events` compression policy and
 * `compute-cost-attribution`'s window, so the nightly run ordinarily rewrites
 * only uncompressed chunks and covers exactly the sessions the attribution job
 * will look at next. A wider backfill is a matter of passing a larger
 * `lookbackDays` from an operator script — re-running is free.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

/** Sessions per event fetch. Bounds the working set, not the result. */
const SESSION_BATCH = 100;

/** Rows per UPDATE … FROM (VALUES …). Bounds the statement, not the run. */
const WRITE_BATCH = 500;

type SessionRow = { ended_at: Date; session_id: string; started_at: Date };

type StopRow = {
  event_id: string;
  metadata: unknown;
  session_id: string;
  turn_number: number;
};

type ToolRow = {
  event_id: string;
  session_id: string;
  tool_use_id: string;
  ts: Date;
};

export type TurnLinkageOpts = {
  logger?: Logger | undefined;
  /** Defaults to {@link DEFAULT_LOOKBACK_DAYS}. */
  lookbackDays?: number;
  /** Defaults to `new Date()`. Injectable so tests are not clock-dependent. */
  now?: Date;
};

/**
 * Settled sessions that ended inside the window.
 *
 * `ended_at IS NOT NULL` is not just tidiness: a session still receiving events
 * may not have shipped the Stop for its most recent turn yet, and this job's
 * `turn_number IS NULL` guard means a row linked now is never revisited. Waiting
 * for the session to settle is what makes one pass sufficient.
 *
 * run-kind-exempt: this job operates on rows, not on people — the same class as
 * `compute-cost-attribution` and `reprice-events` (`lib/run-kind.ts`, class 1).
 * A CI session's tool calls have an issuing turn exactly like anyone else's, and
 * skipping them would leave those rows permanently unlinked with nothing to
 * revisit them. Every human-facing read goes through `interactive_events` in
 * `apps/web`, so the guard is applied where the numbers become a dashboard.
 */
async function settledSessions(db: TurnLinkageDb, since: Date): Promise<SessionRow[]> {
  return db.$queryRaw<SessionRow[]>(Prisma.sql`
    SELECT session_id, started_at, ended_at
    FROM sessions
    WHERE ended_at IS NOT NULL
      AND ended_at >= ${since}
    ORDER BY ended_at
  `);
}

/** Earliest `started_at` in a batch — a `ts` floor Timescale can exclude chunks with. */
function earliestStart(sessions: SessionRow[]): Date {
  return sessions.reduce(
    (min, s) => (s.started_at < min ? s.started_at : min),
    sessions[0]?.started_at ?? new Date(0),
  );
}

/**
 * The Stop rows that name which tool calls each turn issued.
 *
 * `metadata` comes back as the parsed jsonb; `lib/turn-linkage.ts` owns reading
 * the array out of it, because that key is a cross-workspace contract with
 * `apps/hook/src/lib/claude-turns.ts` and belongs in one place on this side too.
 *
 * run-kind-exempt: see `settledSessions` — a row-operation whose population is
 * already fixed by the session batch this is called with.
 */
async function stopTurns(db: TurnLinkageDb, sessions: SessionRow[]): Promise<StopRow[]> {
  const ids = Prisma.join(sessions.map((s) => Prisma.sql`${s.session_id}::uuid`));
  return db.$queryRaw<StopRow[]>(Prisma.sql`
    SELECT session_id, event_id, turn_number, metadata
    -- run-kind-exempt: a row-operation, like compute-cost-attribution. The
    -- population is already fixed by the session batch this is called with, and
    -- a CI session's tool calls have an issuing turn exactly like anyone else's.
    FROM events
    WHERE session_id IN (${ids})
      AND ts >= ${earliestStart(sessions)}
      AND event_type = 'Stop'
      AND turn_number IS NOT NULL
    ORDER BY session_id, turn_number
  `);
}

/**
 * The tool rows still missing their linkage.
 *
 * `turn_number IS NULL` is the whole selection: an imported session's rows
 * already carry it and are never touched, and a live session already linked by
 * an earlier run is not re-read.
 *
 * run-kind-exempt: see `settledSessions` — same row-operation, same population.
 */
async function unlinkedToolEvents(db: TurnLinkageDb, sessions: SessionRow[]): Promise<ToolRow[]> {
  const ids = Prisma.join(sessions.map((s) => Prisma.sql`${s.session_id}::uuid`));
  return db.$queryRaw<ToolRow[]>(Prisma.sql`
    SELECT session_id, event_id, ts, tool_use_id
    -- run-kind-exempt: a row-operation, like compute-cost-attribution. The
    -- population is already fixed by the session batch this is called with, and
    -- a CI session's tool calls need linking exactly like anyone else's.
    FROM events
    WHERE session_id IN (${ids})
      AND ts >= ${earliestStart(sessions)}
      AND tool_use_id IS NOT NULL
      AND turn_number IS NULL
    ORDER BY session_id, ts
  `);
}

/** One resolved linkage, ready to write. */
export type LinkageRow = {
  eventId: string;
  parentEventId: string;
  ts: Date;
  turnNumber: number;
};

/** Which chunk a timestamp falls in. Rows outside every chunk cannot be written. */
function bucketByChunk(rows: LinkageRow[], chunks: EventChunk[]): Map<EventChunk, LinkageRow[]> {
  const buckets = new Map<EventChunk, LinkageRow[]>();
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
 * Write one batch of resolved linkages.
 *
 * The chunk's time range is repeated in the predicate because a `ts` bound is
 * what Timescale's chunk exclusion understands, and the join is on
 * `(event_id, ts)` — the hypertable's own key — rather than on `tool_use_id`
 * again, so the write cannot touch a row the read did not select.
 *
 * `turn_number IS NULL` is repeated here as well as in the read. It is what
 * makes a re-run a no-op even if the read raced an import of the same session:
 * a linkage that was CAPTURED always wins over one that was derived.
 *
 * run-kind-exempt: see `settledSessions` — this writes a linkage onto rows, not
 * a report about people, and a CI session's rows need it exactly like an
 * interactive session's.
 */
async function writeBatch(
  db: TurnLinkageDb,
  chunk: EventChunk,
  rows: LinkageRow[],
): Promise<number> {
  const values = Prisma.join(
    rows.map(
      (r) => Prisma.sql`(
        ${r.eventId}::uuid,
        ${r.ts}::timestamptz,
        ${r.turnNumber}::int,
        ${r.parentEventId}::uuid
      )`,
    ),
    ',',
  );

  return db.$executeRaw(Prisma.sql`
    -- run-kind-exempt: writes a linkage onto rows, not a report about people. A
    -- CI session's rows need it written exactly like an interactive session's,
    -- and skipping them would leave them permanently unlinked — and so
    -- permanently unattributed by compute-cost-attribution — with nothing to
    -- revisit them.
    UPDATE events e
    SET turn_number = v.turn_number,
        parent_event_id = v.parent_event_id
    FROM (VALUES ${values}) AS v(event_id, ts, turn_number, parent_event_id)
    WHERE e.event_id = v.event_id
      AND e.ts = v.ts
      AND e.ts >= ${chunk.rangeStart}
      AND e.ts <  ${chunk.rangeEnd}
      AND e.turn_number IS NULL
  `);
}

export async function runLinkTurnEvents(
  db: TurnLinkageDb,
  opts: TurnLinkageOpts = {},
): Promise<void> {
  const logger = opts.logger;
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1_000);

  await withJobRun(db, 'link-turn-events', logger, async () => {
    const sessions = await settledSessions(db, since);
    if (sessions.length === 0) {
      logger?.info({ lookbackDays }, 'link-turn-events: no settled sessions in window');
      return;
    }

    const resolved: LinkageRow[] = [];
    let linkedSessions = 0;
    let unresolvedIds = 0;
    for (let i = 0; i < sessions.length; i += SESSION_BATCH) {
      const batch = sessions.slice(i, i + SESSION_BATCH);
      const tools = await unlinkedToolEvents(db, batch);
      if (tools.length === 0) {
        continue;
      }
      // Only fetch Stops for the sessions that actually have unlinked tool rows:
      // in steady state most sessions in the window are already linked, and the
      // Stop read is the larger of the two.
      const needing = new Set(tools.map((t) => t.session_id));
      const stops = await stopTurns(
        db,
        batch.filter((s) => needing.has(s.session_id)),
      );

      const stopsBySession = new Map<string, StopTurn[]>();
      for (const s of stops) {
        const list = stopsBySession.get(s.session_id) ?? [];
        list.push({ eventId: s.event_id, metadata: s.metadata, turnNumber: s.turn_number });
        stopsBySession.set(s.session_id, list);
      }
      const toolsBySession = new Map<string, ToolEvent[]>();
      for (const t of tools) {
        const list = toolsBySession.get(t.session_id) ?? [];
        list.push({ eventId: t.event_id, toolUseId: t.tool_use_id, ts: t.ts });
        toolsBySession.set(t.session_id, list);
      }

      for (const [sessionId, sessionTools] of toolsBySession) {
        const { rows, unresolved } = linkageForSession(
          stopsBySession.get(sessionId) ?? [],
          sessionTools,
        );
        unresolvedIds += unresolved;
        if (rows.length > 0) {
          linkedSessions += 1;
          resolved.push(...rows);
        }
      }
    }

    if (resolved.length === 0) {
      logger?.info(
        { lookbackDays, sessions: sessions.length, unresolvedIds },
        'link-turn-events: nothing to link in window',
      );
      return;
    }

    const chunks = await listEventChunks(db, since);
    const buckets = bucketByChunk(resolved, chunks);

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
        chunks: buckets.size,
        linkedSessions,
        rows: resolved.length,
        sessions: sessions.length,
        // A non-zero count is the honest signal that some tool calls could not be
        // placed — a truncated transcript, a hook older than P14-006, or a Stop
        // that never shipped. Those rows stay NULL rather than being guessed at.
        unresolvedIds,
        updated,
      },
      'link-turn-events: applied',
    );
  });
}
