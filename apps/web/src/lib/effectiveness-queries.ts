import { Prisma } from '@ai-agents-observability/db';
import { computeFrictionScore } from './effectiveness';
import { getPrisma } from './prisma';

export type DateRange = { since: Date; until?: Date };

export type FrictionTrendPoint = { date: string; frictionScore: number };
export type ShapeHistogram = Record<string, number>;

export type UserEffectiveness = {
  // Number of sessions in range with a non-null (sufficient-data) friction score.
  scoredSessionCount: number;
  // { [shapeLabel]: sessionCount } over the range.
  shapeHistogram: ShapeHistogram;
  // One point per day that has at least one scored session, friction averaged.
  trend: FrictionTrendPoint[];
};

export type FrictionPercentiles = { p25: number; p50: number; p75: number };

export type EffectivenessDistribution = {
  // Null when no session in scope has a friction score (never a misleading 0).
  friction: FrictionPercentiles | null;
  scoredSessions: number;
  // { [shapeLabel]: proportion } where proportions sum to ~1.
  shapeMix: Record<string, number>;
};

type EffRow = {
  ended_at: Date | null;
  friction_score: number | null;
  interrupt_count: number;
  permission_deny_count: number;
  shape_label: string | null;
  started_at: Date;
  status: string;
  tool_call_count: number;
  tool_error_count: number;
  user_message_count: number;
};

/**
 * Effective friction = the stored value, or an on-the-fly recompute from the
 * session's aggregate columns for the very latest sessions that haven't cleared
 * the nightly compute-effectiveness job yet (no event-table join — cheap).
 * `computeFrictionScore` returns null for low-data sessions, so a null result is
 * genuine "insufficient data" (DESIGN_DOC §10.6), never a zero.
 */
function effectiveFriction(r: EffRow): number | null {
  if (r.friction_score !== null) {
    return r.friction_score;
  }
  const durationSeconds = r.ended_at
    ? Math.round((r.ended_at.getTime() - r.started_at.getTime()) / 1000)
    : null;
  return computeFrictionScore({
    durationSeconds,
    interruptCount: r.interrupt_count,
    permissionDenyCount: r.permission_deny_count,
    status: r.status,
    toolCallCount: r.tool_call_count,
    toolErrorCount: r.tool_error_count,
    userMessageCount: r.user_message_count,
  });
}

function untilFragment(range: DateRange) {
  return range.until ? Prisma.sql`AND started_at < ${range.until}` : Prisma.empty;
}

/**
 * Friction trend + shape histogram for a single user. Bucketed in JS (rather than
 * SQL AVG) so the null-aware on-the-fly fallback can apply per session; the row
 * set is one user over a bounded window, so this stays cheap.
 *
 * Shape labels use the stored value only — classifying a not-yet-scored session
 * accurately needs the tool histogram (an event-table join we deliberately avoid
 * here); such sessions are a small recent tail and simply omitted from the mix.
 */
export async function getUserEffectiveness(
  userId: string,
  range: DateRange,
): Promise<UserEffectiveness> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<EffRow[]>(Prisma.sql`
    SELECT started_at, ended_at, status, shape_label, friction_score,
           tool_call_count, tool_error_count, permission_deny_count,
           interrupt_count, user_message_count
    FROM sessions
    WHERE user_id = ${userId}::uuid
      AND started_at >= ${range.since}
      ${untilFragment(range)}
    ORDER BY started_at ASC
  `);

  const dayBuckets = new Map<string, { count: number; sum: number }>();
  const shapeHistogram: ShapeHistogram = {};
  let scoredSessionCount = 0;

  for (const r of rows) {
    const friction = effectiveFriction(r);
    if (friction !== null) {
      scoredSessionCount++;
      const day = r.started_at.toISOString().slice(0, 10);
      const bucket = dayBuckets.get(day) ?? { count: 0, sum: 0 };
      bucket.count++;
      bucket.sum += friction;
      dayBuckets.set(day, bucket);
    }
    if (r.shape_label !== null) {
      shapeHistogram[r.shape_label] = (shapeHistogram[r.shape_label] ?? 0) + 1;
    }
  }

  const trend: FrictionTrendPoint[] = [...dayBuckets.entries()]
    .map(([date, b]) => ({ date, frictionScore: b.sum / b.count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { scoredSessionCount, shapeHistogram, trend };
}

/**
 * Aggregate friction percentiles + shape mix over a set of sessions. Uses the
 * stored `friction_score` / `shape_label` columns directly via PERCENTILE_CONT —
 * at aggregate scale the recompute fallback isn't worth the row scan, and the
 * nightly job + P7-001 backfill keep stored coverage high. Pass `userIds` to scope
 * to a team; omit for org-wide. Visibility-policy filtering is the caller's job.
 */
async function effectivenessDistribution(
  range: DateRange,
  userIds?: string[],
): Promise<EffectivenessDistribution> {
  // An explicit empty cohort aggregates nothing — short-circuit before SQL.
  if (userIds && userIds.length === 0) {
    return { friction: null, scoredSessions: 0, shapeMix: {} };
  }

  const prisma = getPrisma();
  const userFilter =
    userIds && userIds.length > 0
      ? Prisma.sql`AND user_id = ANY(${userIds}::uuid[])`
      : Prisma.empty;
  const until = untilFragment(range);

  const [pctRows, shapeRows] = await Promise.all([
    prisma.$queryRaw<
      { count: bigint; p25: number | null; p50: number | null; p75: number | null }[]
    >(Prisma.sql`
      SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY friction_score) AS p25,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY friction_score) AS p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY friction_score) AS p75,
        COUNT(friction_score) AS count
      FROM sessions
      WHERE friction_score IS NOT NULL
        AND started_at >= ${range.since}
        ${until}
        ${userFilter}
    `),
    prisma.$queryRaw<{ count: bigint; shape_label: string }[]>(Prisma.sql`
      SELECT shape_label, COUNT(*) AS count
      FROM sessions
      WHERE shape_label IS NOT NULL
        AND started_at >= ${range.since}
        ${until}
        ${userFilter}
      GROUP BY shape_label
    `),
  ]);

  const pct = pctRows[0];
  const scoredSessions = pct ? Number(pct.count) : 0;
  const friction =
    pct && pct.p50 !== null ? { p25: pct.p25 ?? 0, p50: pct.p50, p75: pct.p75 ?? 0 } : null;

  const totalShape = shapeRows.reduce((s, r) => s + Number(r.count), 0);
  const shapeMix: Record<string, number> = {};
  for (const r of shapeRows) {
    shapeMix[r.shape_label] = totalShape > 0 ? Number(r.count) / totalShape : 0;
  }

  return { friction, scoredSessions, shapeMix };
}

export function getTeamEffectivenessDistribution(
  userIds: string[],
  range: DateRange,
): Promise<EffectivenessDistribution> {
  return effectivenessDistribution(range, userIds);
}

export function getOrgEffectivenessDistribution(
  range: DateRange,
): Promise<EffectivenessDistribution> {
  return effectivenessDistribution(range);
}
