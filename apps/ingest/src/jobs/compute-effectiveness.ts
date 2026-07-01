import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import { classifySessionShape, computeFrictionScore } from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';

import { aggregateResponseLatency } from '../lib/response-latency';

type DbWithRaw = Pick<PrismaClient, 'jobRun'> & {
  $executeRaw: PrismaClient['$executeRaw'];
  $queryRaw: PrismaClient['$queryRaw'];
};

type ToolRow = { call_count: bigint; tool_name: string };

type SessionEffRow = {
  ended_at: Date | null;
  interrupt_count: number;
  permission_deny_count: number;
  session_id: string;
  started_at: Date;
  status: string;
  tool_call_count: number;
  tool_error_count: number;
  user_message_count: number;
};

// Default page size for the historical backfill. Keeps each UPDATE bounded so the
// backfill never takes a table-wide lock on `sessions`.
const BACKFILL_BATCH_SIZE = 500;

// Nil UUID — the cursor seed; every real session_id sorts after it.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Scores a batch of session rows: batch-fetches their PostToolUse tool histograms
 * in one query (avoids N+1), then writes `friction_score` + `shape_label` per
 * session. Shared by the nightly window job and the historical backfill. Returns
 * the number of rows updated.
 *
 * `shape_label` is the canonical "has this session been scored yet" marker:
 * `classifySessionShape` is total (always returns a label — worst case 'minimal'),
 * whereas `computeFrictionScore` legitimately returns NULL for low-data sessions.
 * Selecting unscored sessions on `shape_label IS NULL` therefore keeps re-runs
 * idempotent — a once-scored session never re-enters the candidate set even if its
 * friction score is (correctly) null.
 */
async function processEffectivenessBatch(
  db: DbWithRaw,
  sessions: SessionEffRow[],
  logger?: Logger,
): Promise<number> {
  const sessionIds = sessions.map((s) => s.session_id);
  const allHistograms = sessionIds.length
    ? await db.$queryRaw<(ToolRow & { session_id: string })[]>(Prisma.sql`
        SELECT session_id::text AS session_id, tool_name, COUNT(*) AS call_count
        FROM events
        WHERE session_id = ANY(${sessionIds}::uuid[])
          AND event_type = 'PostToolUse'
          AND tool_name IS NOT NULL
        GROUP BY session_id, tool_name
      `)
    : [];

  const histogramMap = new Map<string, ToolRow[]>();
  for (const row of allHistograms) {
    const existing = histogramMap.get(row.session_id) ?? [];
    existing.push({ call_count: row.call_count, tool_name: row.tool_name });
    histogramMap.set(row.session_id, existing);
  }

  // HITL response latency: gap between each blocking Notification and the next
  // event in the session (LEAD), aggregated per session. One batch query.
  const gapRows = sessionIds.length
    ? await db.$queryRaw<
        { gap_ms: number; notification_kind: string | null; session_id: string }[]
      >(
        Prisma.sql`
          SELECT session_id::text AS session_id, notification_kind,
                 EXTRACT(EPOCH FROM (next_ts - ts)) * 1000 AS gap_ms
          FROM (
            SELECT session_id, ts, notification_kind,
                   LEAD(ts) OVER (PARTITION BY session_id ORDER BY ts) AS next_ts
            FROM events
            WHERE session_id = ANY(${sessionIds}::uuid[])
          ) q
          WHERE notification_kind IS NOT NULL AND next_ts IS NOT NULL
        `,
      )
    : [];
  const latencyMap = aggregateResponseLatency(
    gapRows.map((r) => ({
      gap_ms: Number(r.gap_ms),
      notification_kind: r.notification_kind,
      session_id: r.session_id,
    })),
  );

  let updated = 0;
  for (const s of sessions) {
    try {
      const durationSeconds = s.ended_at
        ? Math.round((s.ended_at.getTime() - s.started_at.getTime()) / 1000)
        : null;

      const frictionScore = computeFrictionScore({
        durationSeconds,
        interruptCount: s.interrupt_count,
        permissionDenyCount: s.permission_deny_count,
        status: s.status,
        toolCallCount: s.tool_call_count,
        toolErrorCount: s.tool_error_count,
        userMessageCount: s.user_message_count,
      });

      const histogram = (histogramMap.get(s.session_id) ?? []).map((r) => ({
        callCount: Number(r.call_count),
        toolName: r.tool_name,
      }));
      const shapeLabel = classifySessionShape(histogram, s.user_message_count, s.tool_call_count);

      const latency = latencyMap.get(s.session_id) ?? { sampleCount: 0, totalMs: 0 };

      await db.$executeRaw(Prisma.sql`
        UPDATE sessions
        SET friction_score        = ${frictionScore},
            shape_label           = ${shapeLabel},
            total_response_ms     = ${latency.totalMs},
            response_sample_count = ${latency.sampleCount}
        WHERE session_id = ${s.session_id}::uuid
      `);

      updated++;
    } catch (err) {
      logger?.warn({ err, sessionId: s.session_id }, 'Failed to update session effectiveness');
    }
  }
  return updated;
}

/**
 * Nightly job: computes friction_score and shape_label for recently updated
 * sessions that don't yet have these values (48-hour window).
 */
export async function runComputeEffectiveness(db: DbWithRaw, logger?: Logger): Promise<void> {
  const jobName = 'compute-effectiveness';
  const startedAt = new Date();

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

    // Unscored sessions (shape_label IS NULL) updated in the last 48 hours.
    const sessions = await db.$queryRaw<SessionEffRow[]>(Prisma.sql`
      SELECT
        session_id, status, started_at, ended_at,
        tool_call_count, tool_error_count, permission_deny_count,
        interrupt_count, user_message_count
      FROM sessions
      WHERE shape_label IS NULL
        AND last_event_at >= NOW() - INTERVAL '48 hours'
      LIMIT 500
    `);

    const updated = await processEffectivenessBatch(db, sessions, logger);

    await (db as Pick<PrismaClient, 'jobRun'>).jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });

    logger?.info(
      { jobName, total: sessions.length, updated },
      'Effectiveness computation complete',
    );
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Effectiveness computation failed');
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

/**
 * One-shot backfill: scores ALL historical sessions that have never been scored
 * (`shape_label IS NULL`), with no recency window — the bridge for sessions older
 * than the nightly job's 48-hour reach (DESIGN_DOC §10.3 "captured now, surfaced
 * later"). Batched via a `session_id` cursor so it (a) never issues an unbounded
 * UPDATE that locks the table and (b) advances past any row that fails to update
 * rather than re-fetching it forever within a single run. Idempotent: scored
 * sessions drop out of the `shape_label IS NULL` filter, so a re-run over an
 * already-backfilled dataset processes nothing.
 *
 * Intended for operator-initiated one-shot invocation (via `triggerJob` from a
 * script), not the scheduler — it has no configured cadence.
 */
export async function runComputeEffectivenessBackfill(
  db: DbWithRaw,
  logger?: Logger,
  batchSize: number = BACKFILL_BATCH_SIZE,
): Promise<void> {
  const jobName = 'compute-effectiveness-backfill';
  const startedAt = new Date();

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

    let cursor = NIL_UUID;
    let totalUpdated = 0;
    let batches = 0;
    for (;;) {
      const sessions = await db.$queryRaw<SessionEffRow[]>(Prisma.sql`
        SELECT
          session_id, status, started_at, ended_at,
          tool_call_count, tool_error_count, permission_deny_count,
          interrupt_count, user_message_count
        FROM sessions
        WHERE shape_label IS NULL
          AND session_id > ${cursor}::uuid
        ORDER BY session_id
        LIMIT ${batchSize}
      `);
      if (sessions.length === 0) {
        break;
      }

      totalUpdated += await processEffectivenessBatch(db, sessions, logger);
      batches++;

      const last = sessions[sessions.length - 1];
      if (!last) {
        break;
      }
      cursor = last.session_id;
    }

    await (db as Pick<PrismaClient, 'jobRun'>).jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });

    logger?.info({ batches, jobName, updated: totalUpdated }, 'Effectiveness backfill complete');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Effectiveness backfill failed');
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
