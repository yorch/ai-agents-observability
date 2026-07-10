import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type WeeklyShapeBucket = { shapeCounts: Record<string, number>; weekStart: string };

/**
 * Weekly session-shape histogram for one user. Only sessions with a computed
 * `shape_label` count. Powers the /me shape-shift view — does the mix move from
 * exploratory/debugging toward focused-edit over the window (a proficiency
 * signal)? Scoped by `user_id`; no visibility policy applies (own data).
 */
export async function getUserShapeTrend(userId: string, since: Date): Promise<WeeklyShapeBucket[]> {
  const rows = await getPrisma().$queryRaw<{ count: bigint; shape_label: string; week: Date }[]>(
    Prisma.sql`
      SELECT
        date_trunc('week', started_at) AS week,
        shape_label,
        COUNT(*) AS count
      FROM sessions
      WHERE user_id = ${userId}::uuid
        AND started_at >= ${since}
        AND shape_label IS NOT NULL
      GROUP BY date_trunc('week', started_at), shape_label
      ORDER BY week ASC
    `,
  );

  const byWeek = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const weekStart = r.week.toISOString();
    const shapeCounts = byWeek.get(weekStart) ?? {};
    shapeCounts[r.shape_label] = Number(r.count);
    byWeek.set(weekStart, shapeCounts);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([weekStart, shapeCounts]) => ({ shapeCounts, weekStart }));
}

export type CohortFrictionRow = {
  cohortMonth: string;
  medianFriction: number | null;
  scoredSessions: number;
  userCount: number;
};

/**
 * Median friction per first-seen-month cohort over the window, visibility-scoped
 * to org-metadata sharers (same `share_metadata_with_org` join as org-queries.ts).
 * Cohort = month of the user's earliest session ever (tenure proxy; no HR data),
 * so the answer to "do newer cohorts ramp to the same effectiveness as veterans?"
 * doesn't depend on the trailing window also containing that user's first session.
 * Small cohorts are suppressed by the rendering component, not here.
 */
export async function getOrgCohortFriction(since: Date): Promise<CohortFrictionRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      cohort_month: string;
      median_friction: number | null;
      scored_sessions: bigint;
      user_count: bigint;
    }[]
  >(Prisma.sql`
    WITH first_seen AS (
      SELECT user_id, to_char(date_trunc('month', MIN(started_at)), 'YYYY-MM') AS cohort_month
      FROM sessions
      GROUP BY user_id
    )
    SELECT
      fs.cohort_month                                       AS cohort_month,
      COUNT(DISTINCT s.user_id)                              AS user_count,
      COUNT(*) FILTER (WHERE s.friction_score IS NOT NULL)  AS scored_sessions,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.friction_score) AS median_friction
    FROM sessions s
    JOIN first_seen fs ON fs.user_id = s.user_id
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${since}
      AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY fs.cohort_month
    ORDER BY fs.cohort_month ASC
  `);

  return rows.map((r) => ({
    cohortMonth: r.cohort_month,
    medianFriction: r.median_friction !== null ? Number(r.median_friction) : null,
    scoredSessions: Number(r.scored_sessions),
    userCount: Number(r.user_count),
  }));
}
