import { Prisma } from '@ai-agents-observability/db';
import { cache } from 'react';
import { getPrisma } from './prisma';
import type { GuardMetrics, PostPeriodActuals } from './projections';
import { CHEAP_SUITABLE_CATEGORIES } from './routing-queries';

/**
 * The actuals side of the projection registry (P13-006).
 *
 * Everything here answers one question: what actually happened during a
 * projection's target period? The comparison itself lives in `projections.ts`
 * as a pure function — these queries only fetch, so the interesting logic stays
 * unit-testable and the SQL stays boring.
 *
 * Visibility scoping mirrors the org queries these numbers sit beside
 * (`org-queries.ts`): a user who has opted out of sharing metadata with the org
 * is excluded here for the same reason they are excluded there, so a projection
 * and its realization are drawn from the same population.
 */

/** Only the org population is in scope; these are org-level surfaces. */
const ORG_VISIBLE = Prisma.sql`COALESCE(vp.share_metadata_with_org, true) = true`;

/**
 * The outcome guard's raw inputs over a window: mean session friction, tool-error
 * rate, and the revert rate of PRs merged in that window.
 *
 * Measured at org level rather than per segment, deliberately. A routing change
 * is an org-wide configuration decision and a session touches several models, so
 * there is no honest per-model attribution of "did outcomes get worse" — and
 * inventing one would make the guard look more precise than it is. Null for a
 * metric with no rows behind it: "not measurable" is reported as itself, never
 * as a benign zero.
 */
async function computeGuardMetrics(from: Date, to: Date): Promise<GuardMetrics> {
  const db = getPrisma();
  const [sessionRows, prRows] = await Promise.all([
    db.$queryRaw<{ friction_mean: number | null; tool_calls: bigint; tool_errors: bigint }[]>(
      Prisma.sql`
        SELECT
          AVG(s.friction_score)                   AS friction_mean,
          COALESCE(SUM(s.tool_call_count), 0)     AS tool_calls,
          COALESCE(SUM(s.tool_error_count), 0)    AS tool_errors
        FROM interactive_sessions s
        JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE s.started_at >= ${from}
          AND s.started_at < ${to}
          AND ${ORG_VISIBLE}
      `,
    ),
    // run-kind-exempt: pull_requests are outcomes of work, not runs — the table
    // carries no run_kind and joining sessions to filter it would drop every PR
    // whose contributing sessions predate the window.
    db.$queryRaw<{ merged: bigint; reverted: bigint }[]>(Prisma.sql`
      SELECT
        COUNT(*)                                            AS merged,
        COUNT(*) FILTER (WHERE pr.reverted_at IS NOT NULL)  AS reverted
      FROM pull_requests pr
      WHERE pr.state = 'MERGED'
        AND pr.merged_at >= ${from}
        AND pr.merged_at < ${to}
    `),
  ]);

  const calls = Number(sessionRows[0]?.tool_calls ?? 0);
  const errors = Number(sessionRows[0]?.tool_errors ?? 0);
  const merged = Number(prRows[0]?.merged ?? 0);
  const reverted = Number(prRows[0]?.reverted ?? 0);

  return {
    frictionMean: sessionRows[0]?.friction_mean ?? null,
    revertRate: merged > 0 ? reverted / merged : null,
    toolErrorRate: calls > 0 ? errors / calls : null,
  };
}

/**
 * Per-request memo of the guard query, keyed by the window's two instants.
 *
 * The realization panels map an actuals fetch over every closed claim, and each
 * actuals fetch needs the guard for its period. But the guard is **org-level** —
 * it takes no segment (see above) — and claims recorded together share a period,
 * so M segments were re-running the same two aggregates M times per page view on
 * a `force-dynamic` page.
 *
 * Keyed on `getTime()` rather than on the `Date` objects themselves: each closed
 * projection carries its own `Date` instances, so identity-based memoization
 * (React's `cache` on the function directly) would miss every one of them.
 *
 * `cache` scopes the map to a single request, which is the only correct lifetime
 * here — a process-wide map would serve one request's org metrics to the next.
 * Outside a React request scope it degrades to no memoization, never to a stale
 * answer.
 */
const guardMemo = cache((): Map<string, Promise<GuardMetrics>> => new Map());

export function getGuardMetrics(from: Date, to: Date): Promise<GuardMetrics> {
  const key = `${from.getTime()}:${to.getTime()}`;
  const memo = guardMemo();
  const inFlight = memo.get(key);
  if (inFlight) {
    return inFlight;
  }
  // Stored before awaiting, so concurrent callers in the same request share one
  // query rather than racing to start their own.
  const pending = computeGuardMetrics(from, to);
  memo.set(key, pending);
  return pending;
}

/**
 * Total spend and session volume in a window — the actual behind a
 * `monthly_spend` / `rolling_30d_spend` claim. `teamSlug` narrows to one team's
 * members for the per-team forecasts on the same card.
 */
export async function getSpendActuals(
  from: Date,
  to: Date,
  teamSlug?: string,
): Promise<PostPeriodActuals> {
  const teamJoin = teamSlug
    ? Prisma.sql`
        JOIN team_members tm ON tm.user_id = u.id AND tm.left_at IS NULL
        JOIN teams t ON t.id = tm.team_id AND t.github_slug = ${teamSlug}
      `
    : Prisma.empty;

  const rows = await getPrisma().$queryRaw<{ session_count: bigint; total_cost: number }[]>(
    Prisma.sql`
      SELECT
        COALESCE(SUM(s.total_cost_usd), 0) AS total_cost,
        COUNT(*)                           AS session_count
      FROM interactive_sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      ${teamJoin}
      WHERE s.started_at >= ${from}
        AND s.started_at < ${to}
        AND ${ORG_VISIBLE}
    `,
  );

  return {
    actualValue: Number(rows[0]?.total_cost ?? 0),
    guard: await getGuardMetrics(from, to),
    volume: Number(rows[0]?.session_count ?? 0),
  };
}

/**
 * Premium-model spend on retrieval-only tool categories in a window — the actual
 * behind a `routing_savings` claim. The claim was "move this spend to a cheaper
 * tier"; the realized reduction is therefore `baseline − this`, computed by
 * `realizeProjection`, so this function stays a plain measurement.
 *
 * The category set comes from `routing-queries.ts` rather than being restated,
 * so the projection and its check can never disagree about what "retrieval-only"
 * means.
 *
 * It measures the SAME quantity the claim was registered from — the P14-005
 * redistribution documented on `getOrgModelRoutingBreakdown` (org-queries.ts):
 * the model off the issuing turn's `Stop`, the dollars off the tool row's
 * `attributed_cost_usd`. If the baseline and the actual ever came from two
 * different lenses, every realization would report a saving or a regression that
 * is purely a change of measure.
 *
 * `actualValue` stays a number rather than going nullable: `realizeProjection`
 * takes a measurement, and a window with no attribution is reported through
 * `volume` (the call count), which is zero exactly when nothing was measured.
 */
export async function getRoutingActuals(
  model: string,
  from: Date,
  to: Date,
): Promise<PostPeriodActuals> {
  const categories = Prisma.join([...CHEAP_SUITABLE_CATEGORIES]);
  const rows = await getPrisma().$queryRaw<{ call_count: bigint; cheap_cost: string | null }[]>(
    Prisma.sql`
      SELECT
        SUM(tool.attributed_cost_usd)::text AS cheap_cost,
        COUNT(*)                            AS call_count
      FROM interactive_events tool
      JOIN interactive_events turn
        ON turn.session_id  = tool.session_id
       AND turn.event_id    = tool.parent_event_id
       AND turn.ts         >= ${from}
       AND turn.ts         <  ${to}
       AND turn.event_type  = 'Stop'
       AND turn.model       = ${model}
      WHERE tool.ts >= ${from}
        AND tool.ts < ${to}
        AND tool.event_type = 'PostToolUse'
        AND tool.tool_category IN (${categories})
    `,
  );

  return {
    actualValue: Number(rows[0]?.cheap_cost ?? 0),
    guard: await getGuardMetrics(from, to),
    volume: Number(rows[0]?.call_count ?? 0),
  };
}
