import { Prisma } from '@ai-agents-observability/db';
import type { FrictionComponents } from '@ai-agents-observability/schemas';
import { frictionComponents, frictionScoreFromComponents } from './effectiveness';
import { getPrisma } from './prisma';

// Friction-source driver keys, derived from the shared FrictionComponents type so
// adding a component forces this list (and the typed accumulator) to be updated
// rather than silently aggregating the new driver to zero.
const COMPONENT_KEYS = [
  'abandonment',
  'denial',
  'error',
  'interrupt',
] as const satisfies readonly (keyof FrictionComponents)[];

export type DateRange = { since: Date; until?: Date };

export type FrictionTrendPoint = { date: string; frictionScore: number };
export type ShapeHistogram = Record<string, number>;

// Mean weighted contribution of each friction driver across the user's scored
// sessions. Summing the four ≈ the mean friction score, so this answers "what is
// driving my friction" — the input to the top-sources widget and recommendations.
export type FrictionSources = FrictionComponents;

export type UserEffectiveness = {
  // Number of sessions in range with a non-null (sufficient-data) friction score.
  scoredSessionCount: number;
  // { [shapeLabel]: sessionCount } over the range.
  shapeHistogram: ShapeHistogram;
  // Mean weighted friction contribution per driver over the scored sessions.
  sources: FrictionSources;
  // One point per day that has at least one scored session, friction averaged.
  trend: FrictionTrendPoint[];
};

export type FrictionPercentiles = { p25: number; p50: number; p75: number };

export type EffectivenessDistribution = {
  // Null when no session in scope has a friction score (never a misleading 0).
  friction: FrictionPercentiles | null;
  scoredSessions: number;
  // { [shapeLabel]: sessionCount } — integer counts (NOT proportions), so the
  // shared ShapeDistributionChart (which renders counts) is fed consistently with
  // the per-user shapeHistogram. The chart derives proportions itself.
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

// Weighted friction components for one session from its raw aggregate columns.
// Computed once per row and reused for both the score and the source breakdown.
// `frictionComponents` returns null for low-data sessions, so a null result is
// genuine "insufficient data" (DESIGN_DOC §10.6), never a zero.
function rowComponents(r: EffRow): FrictionComponents | null {
  const durationSeconds = r.ended_at
    ? Math.round((r.ended_at.getTime() - r.started_at.getTime()) / 1000)
    : null;
  return frictionComponents({
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
  const sourceSums: FrictionSources = { abandonment: 0, denial: 0, error: 0, interrupt: 0 };
  let scoredSessionCount = 0;

  for (const r of rows) {
    const comp = rowComponents(r);
    // Stored score wins (matches the nightly job); fall back to the just-computed
    // components for the recent tail not yet scored. Null comp = insufficient data.
    const friction =
      r.friction_score !== null
        ? r.friction_score
        : comp
          ? frictionScoreFromComponents(comp)
          : null;
    if (friction !== null) {
      scoredSessionCount++;
      const day = r.started_at.toISOString().slice(0, 10);
      const bucket = dayBuckets.get(day) ?? { count: 0, sum: 0 };
      bucket.count++;
      bucket.sum += friction;
      dayBuckets.set(day, bucket);

      if (comp) {
        for (const k of COMPONENT_KEYS) {
          sourceSums[k] += comp[k];
        }
      }
    }
    if (r.shape_label !== null) {
      shapeHistogram[r.shape_label] = (shapeHistogram[r.shape_label] ?? 0) + 1;
    }
  }

  const trend: FrictionTrendPoint[] = [...dayBuckets.entries()]
    .map(([date, b]) => ({ date, frictionScore: b.sum / b.count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const sources: FrictionSources = { abandonment: 0, denial: 0, error: 0, interrupt: 0 };
  if (scoredSessionCount > 0) {
    for (const k of COMPONENT_KEYS) {
      sources[k] = sourceSums[k] / scoredSessionCount;
    }
  }

  return { scoredSessionCount, shapeHistogram, sources, trend };
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

  const shapeMix: Record<string, number> = {};
  for (const r of shapeRows) {
    shapeMix[r.shape_label] = Number(r.count);
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
