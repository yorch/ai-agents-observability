import { Prisma } from '@ai-agents-observability/db';
import {
  denialRetrySuccessCount,
  editThrashScore,
  redundantReadScore,
  retryLoopScore,
  type ScoreInput,
  type StepEfficiencyBaseline,
  stepEfficiencyRatio,
  TRAJECTORY_MIN_TOOL_CALLS,
  type TrajectoryEvent,
  testCommandRun,
} from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';
import { scoreUpserts } from '../lib/scores';
import { type JobRawDb, withJobRun } from './job-run';

/**
 * Deterministic trajectory scoring (P13-003).
 *
 * A sibling of `compute-effectiveness` rather than an extension of it, because
 * the two have different shapes: effectiveness reads six pre-aggregated counters
 * off the `sessions` row, whereas this reads the *ordered event list* of each
 * session. Bolting an event walk onto the existing job would have made the
 * cheap nightly path pay for the expensive one.
 *
 * Everything it writes lands in `scores` with `source: DETERMINISTIC`. Nothing
 * lands on a `sessions` column and **nothing is surfaced on a dashboard** —
 * whether these numbers mean anything is P13-007's question, and displaying them
 * first would be the exact "unvalidated number that reads as a verdict" failure
 * the phase exists to prevent.
 *
 * Memory is bounded by construction: a keyset walk in small batches, and a hard
 * per-session event cap inside the fetch query, so a pathological 200k-event
 * session cannot pull the process over.
 *
 * The walk is keyed on `(last_event_at, session_id)` rather than on the
 * `session_id` primary key alone. The nightly path wants the sessions with
 * recent activity, and UUID order has nothing to do with recency: keyed on the
 * PK, every night's run read the entire table to find a couple of days' worth of
 * rows, and the cost of "score last night's sessions" grew with the size of the
 * corpus forever. Ordered by `last_event_at`, the nightly run touches only its
 * own window — the same bounded shape `compute-effectiveness`'s nightly path has.
 */

type DbWithRaw = JobRawDb;

/**
 * Sessions per batch. Smaller than `compute-effectiveness`'s 500 because each
 * session here drags its event list along; 100 × the cap below bounds a batch at
 * ~200k event projections worst case, and far less in practice.
 */
const BATCH_SIZE = 100;

/**
 * Events read per session. A session longer than this is already far outside any
 * baseline, and the scorers are rates — truncating changes a score at the
 * margin but cannot change whether it is emitted. The cap is recorded in the
 * score metadata when it bites, so a later reader is not misled.
 */
export const MAX_EVENTS_PER_SESSION = 5000;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Window over which the per-shape step-efficiency baseline is derived. */
const BASELINE_WINDOW_DAYS = 90;

type SessionRow = {
  agent_type: string;
  session_id: string;
  shape_label: string | null;
  tool_call_count: number;
};

/** A candidate plus the cursor column the walk advances on. */
type WalkRow = SessionRow & { last_event_at: Date };

type EventRow = {
  agent_type: string;
  event_type: string;
  session_id: string;
  tool_action: string | null;
  tool_exit_status: number | null;
  tool_input_hash: string | null;
  tool_name: string | null;
  tool_target_hash: string | null;
  tool_was_denied: boolean | null;
  tool_was_interrupted: boolean | null;
};

/**
 * Per-shape step-efficiency baselines, derived from the data rather than
 * hardcoded (P13-003 implementation note). Interactive runs only — a CI or eval
 * run has no human pacing and would drag the median of a "typical developer
 * session" toward something no developer ever had.
 *
 * Population must match what `stepEfficiencyRatio` actually scores: it refuses
 * to score any session with `tool_call_count < TRAJECTORY_MIN_TOOL_CALLS`
 * (too small to characterize), so the baseline excludes them too. Including
 * them here would pull `median_tool_calls` down with sessions that never
 * produce a ratio, deflating the denominator and biasing every emitted ratio
 * high relative to the population it is actually compared against.
 */
export async function loadStepBaselines(
  db: Pick<DbWithRaw, '$queryRaw'>,
): Promise<Map<string, StepEfficiencyBaseline>> {
  const rows = await db.$queryRaw<
    { median_tool_calls: number | null; session_count: bigint; shape_label: string }[]
  >(Prisma.sql`
    SELECT
      shape_label,
      COUNT(*)                                                        AS session_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tool_call_count)    AS median_tool_calls
    FROM interactive_sessions
    WHERE shape_label IS NOT NULL
      AND tool_call_count >= ${TRAJECTORY_MIN_TOOL_CALLS}
      AND last_event_at >= NOW() - (${BASELINE_WINDOW_DAYS} * INTERVAL '1 day')
    GROUP BY shape_label
  `);

  const baselines = new Map<string, StepEfficiencyBaseline>();
  for (const r of rows) {
    baselines.set(r.shape_label, {
      medianToolCalls: Number(r.median_tool_calls ?? 0),
      sessionCount: Number(r.session_count),
      shapeLabel: r.shape_label,
    });
  }
  return baselines;
}

/**
 * Score one batch of sessions. Two batch queries (events, merged-PR links) plus
 * one transaction per session — the same single-query-per-batch discipline
 * `compute-effectiveness` uses to avoid an N+1 over the hypertable.
 *
 * Returns the number of sessions for which at least one score row was written.
 */
export async function processTrajectoryBatch(
  db: DbWithRaw,
  sessions: SessionRow[],
  baselines: Map<string, StepEfficiencyBaseline>,
  logger?: Logger,
): Promise<number> {
  if (sessions.length === 0) {
    return 0;
  }
  const sessionIds = sessions.map((s) => s.session_id);

  // Ordered event projection, capped per session inside the query so the cap is
  // applied by Postgres and never materializes in this process. Fetches one row
  // past the cap (MAX_EVENTS_PER_SESSION + 1): scoring only ever sees the first
  // MAX_EVENTS_PER_SESSION of them, but the presence of that extra row is what
  // lets us tell "exactly the cap, nothing dropped" apart from "more than the
  // cap, truncated" below — `events.length` alone can never do that, since it is
  // clamped to the cap either way.
  //
  // run-kind-exempt: per-session scoring -- `sessions` here is the batch this
  // function was handed by the walk (already selected below), and a trajectory
  // score is a property of one session's event list, not a people-facing
  // aggregate.
  const eventRows = await db.$queryRaw<EventRow[]>(Prisma.sql`
    SELECT session_id::text AS session_id, agent_type, event_type, tool_name,
           tool_input_hash, tool_target_hash, tool_action, tool_exit_status,
           tool_was_denied, tool_was_interrupted
    FROM (
      SELECT session_id, agent_type, event_type, tool_name, tool_input_hash,
             tool_target_hash, tool_action, tool_exit_status, tool_was_denied,
             tool_was_interrupted,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, event_id) AS rn
      -- run-kind-exempt: see the comment above this query -- per-session scoring.
      FROM events
      WHERE session_id = ANY(${sessionIds}::uuid[])
    ) q
    WHERE rn <= ${MAX_EVENTS_PER_SESSION + 1}
    ORDER BY session_id, rn
  `);

  const bySession = new Map<string, TrajectoryEvent[]>();
  const truncatedSessions = new Set<string>();
  for (const r of eventRows) {
    const list = bySession.get(r.session_id) ?? [];
    if (list.length >= MAX_EVENTS_PER_SESSION) {
      // This is the (cap + 1)-th row for the session: proof a real event was
      // dropped from scoring, not scored itself.
      truncatedSessions.add(r.session_id);
      continue;
    }
    list.push({
      agentType: r.agent_type,
      eventType: r.event_type,
      toolAction: r.tool_action,
      toolExitStatus: r.tool_exit_status,
      toolInputHash: r.tool_input_hash,
      toolName: r.tool_name,
      toolTargetHash: r.tool_target_hash,
      toolWasDenied: r.tool_was_denied,
      toolWasInterrupted: r.tool_was_interrupted,
    });
    bySession.set(r.session_id, list);
  }

  // The "before merge" half of tests-run-before-merge is a property of the
  // linked PR, not of the trajectory: a session only earns this score once its
  // work actually shipped.
  const mergedRows = await db.$queryRaw<{ merged_at: Date; session_id: string }[]>(Prisma.sql`
    SELECT l.session_id::text AS session_id, MIN(pr.merged_at) AS merged_at
    FROM session_pr_links l
    JOIN pull_requests pr ON pr.repo_id = l.repo_id AND pr.pr_number = l.pr_number
    WHERE l.session_id = ANY(${sessionIds}::uuid[])
      AND pr.merged_at IS NOT NULL
    GROUP BY l.session_id
  `);
  const mergedAt = new Map(mergedRows.map((r) => [r.session_id, r.merged_at]));

  let written = 0;
  for (const s of sessions) {
    try {
      const events = bySession.get(s.session_id) ?? [];
      // Whether a real event was dropped, established by the (cap + 1)-th row
      // fetched above — not by `events.length`, which is clamped to the cap and
      // so cannot itself distinguish "exactly the cap" from "more than the cap".
      const truncated = truncatedSessions.has(s.session_id);
      const baseline = s.shape_label === null ? undefined : baselines.get(s.shape_label);

      const inputs: ScoreInput[] = [
        {
          metadata: { truncated },
          scorerName: 'trajectory_retry_loop',
          subjectId: s.session_id,
          value: retryLoopScore(events),
        },
        {
          metadata: { truncated },
          scorerName: 'trajectory_edit_thrash',
          subjectId: s.session_id,
          value: editThrashScore(events),
        },
        {
          metadata: { truncated },
          scorerName: 'trajectory_redundant_read',
          subjectId: s.session_id,
          value: redundantReadScore(events),
        },
        {
          metadata: { truncated },
          scorerName: 'trajectory_denial_retry_success',
          subjectId: s.session_id,
          value: denialRetrySuccessCount(events),
        },
        {
          // The baseline travels with the score: a ratio whose denominator has
          // been lost is unreadable, and the median moves as the corpus grows.
          metadata: {
            baselineMedianToolCalls: baseline?.medianToolCalls ?? null,
            baselineSessionCount: baseline?.sessionCount ?? null,
            baselineWindowDays: BASELINE_WINDOW_DAYS,
            shapeLabel: s.shape_label,
            truncated,
          },
          scorerName: 'trajectory_step_efficiency',
          subjectId: s.session_id,
          value: stepEfficiencyRatio(s.tool_call_count, baseline),
        },
      ];

      const merged = mergedAt.get(s.session_id);
      if (merged !== undefined) {
        const ranTests = testCommandRun(events);
        inputs.push({
          metadata: { mergedAt: merged.toISOString(), truncated },
          scorerName: 'trajectory_tests_before_merge',
          subjectId: s.session_id,
          // null (unobservable) stays null and `scoreUpserts` drops the row —
          // "this adapter reports no commands" must not read as "shipped
          // without tests".
          value: ranTests === null ? null : ranTests ? 1 : 0,
        });
      }

      const statements = scoreUpserts(inputs);
      if (statements.length === 0) {
        continue;
      }
      await db.$transaction(statements.map((sql) => db.$executeRaw(sql)));
      written++;
    } catch (err) {
      logger?.warn({ err, sessionId: s.session_id }, 'Failed to write trajectory scores');
    }
  }
  return written;
}

type WalkOptions = {
  batchSize: number;
  /** Extra predicate narrowing the candidate set (the nightly recency window). */
  candidateFilter: Prisma.Sql;
  jobName: string;
};

async function walkSessions(db: DbWithRaw, options: WalkOptions, logger?: Logger): Promise<void> {
  const { batchSize, candidateFilter, jobName } = options;

  await withJobRun(db, jobName, logger, async () => {
    const baselines = await loadStepBaselines(db);

    // Keyset on `(last_event_at, session_id)`, matching the index of the same
    // name added in `20260813110000_sessions_last_event_at_idx`. `session_id`
    // is the tiebreaker only — two sessions can share a millisecond, and
    // without it the walk could skip one of them.
    //
    // A session whose `last_event_at` advances mid-walk moves *forward* past
    // the cursor and may be visited twice. That is harmless and deliberate:
    // scoring is an upsert on (subject, scorer, version), so a second visit
    // rewrites identical rows. It can never move backwards — the upsert takes
    // `GREATEST(existing, incoming)`.
    let cursorTs = new Date(0);
    let cursorId = NIL_UUID;
    let totalWritten = 0;
    let batches = 0;
    for (;;) {
      // run-kind-exempt: candidate walk for the per-session trajectory scorer
      // (nightly window or full re-score, per `candidateFilter`). Trajectory
      // scores are a property of one session's event list, same class as
      // compute-effectiveness — a CI or eval session must be scored too, or its
      // row would carry no explanation for why it was skipped.
      const sessions = await db.$queryRaw<WalkRow[]>(Prisma.sql`
        SELECT session_id, agent_type, shape_label, tool_call_count, last_event_at
        FROM sessions
        WHERE (last_event_at, session_id) > (${cursorTs}::timestamptz, ${cursorId}::uuid)
          AND ${candidateFilter}
        ORDER BY last_event_at, session_id
        LIMIT ${batchSize}
      `);
      if (sessions.length === 0) {
        break;
      }

      totalWritten += await processTrajectoryBatch(db, sessions, baselines, logger);
      batches++;

      // Advance past the batch even if some of its sessions failed to score:
      // the per-session catch inside processTrajectoryBatch keeps one bad row
      // from stalling the walk on it forever.
      const last = sessions[sessions.length - 1];
      if (!last) {
        break;
      }
      cursorTs = last.last_event_at;
      cursorId = last.session_id;
    }

    logger?.info({ batches, jobName, scored: totalWritten }, 'Trajectory scoring complete');
  });
}

/**
 * Nightly: score sessions with recent activity.
 *
 * Idempotency comes from the upsert on `(subject_type, subject_id, scorer_name,
 * scorer_version)`, not from a "has this been scored" marker column. That is the
 * deliberate difference from `compute-effectiveness`, whose `shape_label IS
 * NULL` marker is exactly what made re-scoring impossible: here a re-run over an
 * already-scored window rewrites identical rows, and a *version bump* is picked
 * up by `runRescoreTrajectory` with no bespoke backfill job.
 *
 * The 48-hour window means a session is re-scored on the couple of nights after
 * it ends, which is a feature — late-arriving events change the trajectory.
 *
 * The window is also the whole cost of the run: the walk is ordered by
 * `last_event_at`, so it starts inside the window and stops at its end rather
 * than paging the table to find it.
 */
export async function runComputeTrajectoryScores(
  db: DbWithRaw,
  logger?: Logger,
  batchSize: number = BATCH_SIZE,
): Promise<void> {
  await walkSessions(
    db,
    {
      batchSize,
      candidateFilter: Prisma.sql`last_event_at >= NOW() - INTERVAL '48 hours'`,
      jobName: 'compute-trajectory-scores',
    },
    logger,
  );
}

/**
 * Operator-triggered one-shot: re-score every session at the current scorer
 * versions. The path that makes a scorer change cheap — bump one of the six
 * version constants in `packages/schemas/src/scores.ts`, trigger once, and the
 * new rows land beside the old ones so a trend can show the boundary instead of
 * blending two scorers into one misleading line.
 *
 * No cadence, so it stays out of the scheduler's configurable set.
 */
export async function runRescoreTrajectory(
  db: DbWithRaw,
  logger?: Logger,
  batchSize: number = BATCH_SIZE,
): Promise<void> {
  await walkSessions(
    db,
    {
      batchSize,
      candidateFilter: Prisma.sql`TRUE`,
      jobName: 'rescore-trajectory',
    },
    logger,
  );
}
