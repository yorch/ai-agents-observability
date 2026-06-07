import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import { classifySessionShape, computeFrictionScore } from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';

type DbWithRaw = Pick<PrismaClient, 'jobRun'> & {
  $executeRaw: PrismaClient['$executeRaw'];
  $queryRaw: PrismaClient['$queryRaw'];
};

type ToolRow = { call_count: bigint; tool_name: string };

/**
 * Nightly job: computes friction_score and shape_label for recently updated
 * sessions that don't yet have these values.
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

    // Process sessions where friction_score or shape_label is null,
    // updated in the last 48 hours (handles backfill + ongoing)
    const sessions = await db.$queryRaw<
      {
        ended_at: Date | null;
        interrupt_count: number;
        permission_deny_count: number;
        session_id: string;
        started_at: Date;
        status: string;
        tool_call_count: number;
        tool_error_count: number;
        user_message_count: number;
      }[]
    >(Prisma.sql`
      SELECT
        session_id, status, started_at, ended_at,
        tool_call_count, tool_error_count, permission_deny_count,
        interrupt_count, user_message_count
      FROM sessions
      WHERE shape_label IS NULL
        AND last_event_at >= NOW() - INTERVAL '48 hours'
      LIMIT 500
    `);

    // Batch-fetch tool histograms for all sessions in one query (avoids N+1)
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

        await db.$executeRaw(Prisma.sql`
          UPDATE sessions
          SET friction_score = ${frictionScore},
              shape_label    = ${shapeLabel}
          WHERE session_id = ${s.session_id}::uuid
        `);

        updated++;
      } catch (err) {
        logger?.warn({ err, sessionId: s.session_id }, 'Failed to update session effectiveness');
      }
    }

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
