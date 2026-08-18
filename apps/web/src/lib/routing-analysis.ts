import { Prisma } from '@ai-agents-observability/db';
import type { RoutingRecommendation } from '@/lib/routing-queries';
import { logger } from './logger';
import { getPrisma } from './prisma';

const MIN_REALIZED_CALLS = 25;
const DEGRADE_ERROR_DELTA = 0.05;
const DEGRADE_FRICTION_DELTA = 0.05;
const DEGRADE_REVERT_DELTA = 0.02;

export type RoutingProjectionSnapshot = {
  agentType: string;
  cheapCategories: string[];
  cheapCategoryCalls: number;
  cheapCategorySpendUsd: number;
  id: bigint;
  model: string;
  projectedSavingHighUsd: number;
  projectedSavingLowUsd: number;
  projectedWindowDays: number;
  windowEnd: Date;
  windowStart: Date;
};

export type RoutingProjectionEvaluation = {
  errorRateDelta: number | null;
  frictionDelta: number | null;
  /** True when the realized saving landed inside the projected range. */
  landedInRange: boolean;
  projectedSavingHighUsd: number;
  projectedSavingLowUsd: number;
  realizedCheapCalls: number;
  realizedCheapSpendUsd: number;
  realizedSavingUsd: number;
  revertRateDelta: number | null;
  status: 'degraded' | 'improved' | 'mixed' | 'not_measurable';
};

export type RoutingValidationRow = {
  evaluation: RoutingProjectionEvaluation;
  projection: RoutingProjectionSnapshot;
};

export function evaluateRoutingProjection(
  projection: RoutingProjectionSnapshot,
  observed: {
    /** Cheap-category spend across all of the agent's models, baseline window. */
    baselineCheapSpendUsd: number;
    baselineErrorRate: number | null;
    baselineMedianFriction: number | null;
    baselineRevertRate: number | null;
    realizedCheapCalls: number;
    realizedCheapSpendUsd: number;
    realizedErrorRate: number | null;
    realizedMedianFriction: number | null;
    realizedRevertRate: number | null;
  },
): RoutingProjectionEvaluation {
  if (observed.realizedCheapCalls < MIN_REALIZED_CALLS) {
    return {
      errorRateDelta: null,
      frictionDelta: null,
      landedInRange: false,
      projectedSavingHighUsd: projection.projectedSavingHighUsd,
      projectedSavingLowUsd: projection.projectedSavingLowUsd,
      realizedCheapCalls: observed.realizedCheapCalls,
      realizedCheapSpendUsd: observed.realizedCheapSpendUsd,
      realizedSavingUsd: 0,
      revertRateDelta: null,
      status: 'not_measurable',
    };
  }

  // Measured baseline vs measured realized, both across every model. Using the
  // projection's stored single-model spend as the baseline would compare one
  // model against all models and manufacture a saving whenever work simply moved.
  const realizedSavingUsd = Math.max(
    0,
    observed.baselineCheapSpendUsd - observed.realizedCheapSpendUsd,
  );
  // The projection was a range, so "was it right?" is a containment test, not
  // an equality one. A realized saving above the range is still a win, but it
  // is not the range being accurate — callers can tell the two apart.
  const landedInRange =
    realizedSavingUsd >= projection.projectedSavingLowUsd &&
    realizedSavingUsd <= projection.projectedSavingHighUsd;
  const errorRateDelta =
    observed.realizedErrorRate !== null && observed.baselineErrorRate !== null
      ? observed.realizedErrorRate - observed.baselineErrorRate
      : null;
  const frictionDelta =
    observed.realizedMedianFriction !== null && observed.baselineMedianFriction !== null
      ? observed.realizedMedianFriction - observed.baselineMedianFriction
      : null;
  const revertRateDelta =
    observed.realizedRevertRate !== null && observed.baselineRevertRate !== null
      ? observed.realizedRevertRate - observed.baselineRevertRate
      : null;

  const degraded =
    (errorRateDelta !== null && errorRateDelta > DEGRADE_ERROR_DELTA) ||
    (frictionDelta !== null && frictionDelta > DEGRADE_FRICTION_DELTA) ||
    (revertRateDelta !== null && revertRateDelta > DEGRADE_REVERT_DELTA);

  if (degraded) {
    return {
      errorRateDelta,
      frictionDelta,
      landedInRange,
      projectedSavingHighUsd: projection.projectedSavingHighUsd,
      projectedSavingLowUsd: projection.projectedSavingLowUsd,
      realizedCheapCalls: observed.realizedCheapCalls,
      realizedCheapSpendUsd: observed.realizedCheapSpendUsd,
      realizedSavingUsd,
      revertRateDelta,
      status: 'degraded',
    };
  }

  const improved =
    realizedSavingUsd > 0 &&
    (errorRateDelta === null || errorRateDelta <= 0) &&
    (frictionDelta === null || frictionDelta <= 0) &&
    (revertRateDelta === null || revertRateDelta <= 0);

  return {
    errorRateDelta,
    frictionDelta,
    landedInRange,
    projectedSavingHighUsd: projection.projectedSavingHighUsd,
    projectedSavingLowUsd: projection.projectedSavingLowUsd,
    realizedCheapCalls: observed.realizedCheapCalls,
    realizedCheapSpendUsd: observed.realizedCheapSpendUsd,
    realizedSavingUsd,
    revertRateDelta,
    status: improved ? 'improved' : 'mixed',
  };
}

export async function persistRoutingRecommendationProjections(params: {
  rangeDays: number;
  recommendations: RoutingRecommendation[];
  windowEnd: Date;
  windowStart: Date;
}): Promise<void> {
  const { rangeDays, recommendations, windowEnd, windowStart } = params;
  if (recommendations.length === 0) {
    return;
  }

  const prisma = getPrisma();
  const rows = recommendations.map(
    (rec) =>
      Prisma.sql`(
      ${windowStart},
      ${windowEnd},
      ${rangeDays},
      ${rec.agentType},
      ${rec.model},
      ${rec.topCategories.map((c) => c.category)},
      ${rec.cheapCategoryCalls},
      ${rec.cheapCategorySpend},
      ${rec.cheapCategorySpend > 0 ? (rec.monthlySavingLow * (rangeDays / 30)) / rec.cheapCategorySpend : 0},
      ${rec.cheapCategorySpend > 0 ? (rec.monthlySavingHigh * (rangeDays / 30)) / rec.cheapCategorySpend : 0},
      ${rec.monthlySavingLow * (rangeDays / 30)},
      ${rec.monthlySavingHigh * (rangeDays / 30)}
    )`,
  );

  try {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO routing_recommendation_projections (
        window_start,
        window_end,
        range_days,
        agent_type,
        model,
        cheap_categories,
        cheap_category_calls,
        cheap_category_spend_usd,
        savings_ratio_low,
        savings_ratio_high,
        projected_saving_low_usd,
        projected_saving_high_usd
      ) VALUES ${Prisma.join(rows)}
      ON CONFLICT (window_start, window_end, range_days, agent_type, model)
      DO UPDATE SET
        cheap_categories = EXCLUDED.cheap_categories,
        cheap_category_calls = EXCLUDED.cheap_category_calls,
        cheap_category_spend_usd = EXCLUDED.cheap_category_spend_usd,
        savings_ratio_low = EXCLUDED.savings_ratio_low,
        savings_ratio_high = EXCLUDED.savings_ratio_high,
        projected_saving_low_usd = EXCLUDED.projected_saving_low_usd,
        projected_saving_high_usd = EXCLUDED.projected_saving_high_usd,
        updated_at = now()
    `);
  } catch (err) {
    // Keep /org/models resilient before the migration is applied.
    logger.warn({ err }, 'routing.projections.persist_failed');
  }
}

export async function getRoutingRecommendationValidationRows(params: {
  asOf: Date;
  limit?: number;
  rangeDays: number;
}): Promise<RoutingValidationRow[]> {
  const prisma = getPrisma();
  const { asOf, limit = 12, rangeDays } = params;

  let projections: {
    agent_type: string;
    cheap_categories: string[];
    cheap_category_calls: number;
    cheap_category_spend_usd: string;
    id: bigint;
    model: string;
    projected_saving_high_usd: string;
    projected_saving_low_usd: string;
    range_days: number;
    window_end: Date;
    window_start: Date;
  }[] = [];

  try {
    projections = await prisma.$queryRaw(Prisma.sql`
      SELECT
        id,
        window_start,
        window_end,
        range_days,
        agent_type,
        model,
        cheap_categories,
        cheap_category_calls,
        cheap_category_spend_usd::text,
        projected_saving_low_usd::text,
        projected_saving_high_usd::text
      FROM routing_recommendation_projections
      WHERE range_days = ${rangeDays}
        AND window_end <= ${asOf}
        AND window_end + make_interval(days => range_days) <= ${asOf}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
  } catch (err) {
    logger.warn({ err }, 'routing.validation.query_failed');
    return [];
  }

  const out: RoutingValidationRow[] = [];
  for (const p of projections) {
    const baselineStart = p.window_start;
    const baselineEnd = p.window_end;
    const realizedStart = baselineEnd;
    const realizedEnd = new Date(baselineEnd.getTime() + p.range_days * 24 * 60 * 60 * 1000);

    // Both windows measure cheap-category spend across EVERY model for this
    // agent, not just the model the projection named. Filtering the realized
    // window on the expensive model made the loop structurally unable to see a
    // success: if a team actually adopts the recommendation, calls on that model
    // fall to ~0, the row drops under MIN_REALIZED_CALLS, and the panel reports
    // "not measurable" — reporting nothing precisely when it worked.
    const spendRows = await prisma.$queryRaw<
      {
        baseline_calls: bigint;
        baseline_errors: bigint;
        baseline_spend: string;
        realized_calls: bigint;
        realized_errors: bigint;
        realized_spend: string;
      }[]
    >(Prisma.sql`
      SELECT
        COALESCE(SUM(e.cost_usd) FILTER (WHERE e.ts >= ${baselineStart} AND e.ts < ${baselineEnd}), 0)::text AS baseline_spend,
        COUNT(*) FILTER (WHERE e.ts >= ${baselineStart} AND e.ts < ${baselineEnd}) AS baseline_calls,
        COUNT(*) FILTER (
          WHERE e.ts >= ${baselineStart}
            AND e.ts < ${baselineEnd}
            AND e.tool_exit_status IS NOT NULL
            AND e.tool_exit_status != 0
        ) AS baseline_errors,
        COALESCE(SUM(e.cost_usd) FILTER (WHERE e.ts >= ${realizedStart} AND e.ts < ${realizedEnd}), 0)::text AS realized_spend,
        COUNT(*) FILTER (WHERE e.ts >= ${realizedStart} AND e.ts < ${realizedEnd}) AS realized_calls,
        COUNT(*) FILTER (
          WHERE e.ts >= ${realizedStart}
            AND e.ts < ${realizedEnd}
            AND e.tool_exit_status IS NOT NULL
            AND e.tool_exit_status != 0
        ) AS realized_errors
      FROM events e
      JOIN users u ON u.id = e.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE e.event_type = 'PostToolUse'
        AND e.agent_type = ${p.agent_type}
        AND e.tool_category = ANY(${p.cheap_categories}::text[])
        AND e.ts >= ${baselineStart}
        AND e.ts < ${realizedEnd}
        AND COALESCE(vp.share_metadata_with_org, true) = true
    `);

    const frictionRows = await prisma.$queryRaw<
      {
        baseline_friction: number | null;
        realized_friction: number | null;
      }[]
    >(Prisma.sql`
      SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.friction_score)
          FILTER (WHERE s.started_at >= ${baselineStart} AND s.started_at < ${baselineEnd}) AS baseline_friction,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.friction_score)
          FILTER (WHERE s.started_at >= ${realizedStart} AND s.started_at < ${realizedEnd}) AS realized_friction
      FROM sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.agent_type::text = ${p.agent_type}
        AND s.primary_model = ${p.model}
        AND s.started_at >= ${baselineStart}
        AND s.started_at < ${realizedEnd}
        AND s.friction_score IS NOT NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
    `);

    const revertRows = await prisma.$queryRaw<
      {
        baseline_merged: bigint;
        baseline_reverted: bigint;
        realized_merged: bigint;
        realized_reverted: bigint;
      }[]
    >(Prisma.sql`
      WITH windowed_prs AS (
        SELECT DISTINCT
          pr.repo_id,
          pr.pr_number,
          CASE
            WHEN s.started_at >= ${baselineStart} AND s.started_at < ${baselineEnd} THEN 'baseline'
            WHEN s.started_at >= ${realizedStart} AND s.started_at < ${realizedEnd} THEN 'realized'
            ELSE NULL
          END AS bucket,
          pr.merged_at,
          pr.reverted_at
        FROM session_pr_links spl
        JOIN sessions s ON s.session_id = spl.session_id
        JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        JOIN pull_requests pr ON pr.repo_id = spl.repo_id AND pr.pr_number = spl.pr_number
        WHERE s.agent_type::text = ${p.agent_type}
          AND s.primary_model = ${p.model}
          AND s.started_at >= ${baselineStart}
          AND s.started_at < ${realizedEnd}
          AND COALESCE(vp.share_metadata_with_org, true) = true
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket = 'baseline' AND merged_at IS NOT NULL) AS baseline_merged,
        COUNT(*) FILTER (
          WHERE bucket = 'baseline' AND merged_at IS NOT NULL AND reverted_at IS NOT NULL
        ) AS baseline_reverted,
        COUNT(*) FILTER (WHERE bucket = 'realized' AND merged_at IS NOT NULL) AS realized_merged,
        COUNT(*) FILTER (
          WHERE bucket = 'realized' AND merged_at IS NOT NULL AND reverted_at IS NOT NULL
        ) AS realized_reverted
      FROM windowed_prs
      WHERE bucket IS NOT NULL
    `);

    const spend = spendRows[0];
    const friction = frictionRows[0];
    const revert = revertRows[0];
    if (!spend || !friction || !revert) {
      continue;
    }

    const baselineCalls = Number(spend.baseline_calls);
    const baselineErrors = Number(spend.baseline_errors);
    const realizedCalls = Number(spend.realized_calls);
    const realizedErrors = Number(spend.realized_errors);

    const projection: RoutingProjectionSnapshot = {
      agentType: p.agent_type,
      cheapCategories: p.cheap_categories,
      cheapCategoryCalls: p.cheap_category_calls,
      cheapCategorySpendUsd: Number(p.cheap_category_spend_usd),
      id: p.id,
      model: p.model,
      projectedSavingHighUsd: Number(p.projected_saving_high_usd),
      projectedSavingLowUsd: Number(p.projected_saving_low_usd),
      projectedWindowDays: p.range_days,
      windowEnd: p.window_end,
      windowStart: p.window_start,
    };

    const evaluation = evaluateRoutingProjection(projection, {
      baselineCheapSpendUsd: Number(spend.baseline_spend),
      baselineErrorRate: baselineCalls > 0 ? baselineErrors / baselineCalls : null,
      baselineMedianFriction: friction.baseline_friction,
      baselineRevertRate:
        Number(revert.baseline_merged) > 0
          ? Number(revert.baseline_reverted) / Number(revert.baseline_merged)
          : null,
      realizedCheapCalls: realizedCalls,
      realizedCheapSpendUsd: Number(spend.realized_spend),
      realizedErrorRate: realizedCalls > 0 ? realizedErrors / realizedCalls : null,
      realizedMedianFriction: friction.realized_friction,
      realizedRevertRate:
        Number(revert.realized_merged) > 0
          ? Number(revert.realized_reverted) / Number(revert.realized_merged)
          : null,
    });

    out.push({ evaluation, projection });
  }

  return out;
}
