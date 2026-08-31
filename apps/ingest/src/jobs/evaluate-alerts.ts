import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import {
  AUTONOMY_SURGE_CRITICAL,
  AUTONOMY_SURGE_MIN_SESSIONS,
  AUTONOMY_SURGE_WARN,
  AUTONOMY_SURGE_WINDOW_DAYS,
  BUDGET_THRESHOLD_CRITICAL_RATIO,
  BUDGET_THRESHOLD_WARN_RATIO,
  DISALLOWED_MODEL_CRITICAL_MULTIPLE,
  DISALLOWED_MODEL_DEFAULT_USD,
  DISALLOWED_MODEL_WINDOW_DAYS,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  ERROR_RATE_WINDOW_DAYS,
  LOW_OVERSIGHT_MODES,
  parseBudgetThresholdParams,
  ROUTING_WASTE_CRITICAL_MULTIPLE,
  ROUTING_WASTE_DEFAULT_USD,
  ROUTING_WASTE_WINDOW_DAYS,
  SECRET_EXPOSURE_CLASSES_IN_ALERT,
  SECRET_EXPOSURE_DEFAULT_THRESHOLD,
  SECRET_EXPOSURE_WINDOW_DAYS,
  SPEND_SPIKE_BASELINE_DAYS,
  SPEND_SPIKE_CRITICAL_SIGMA,
  SPEND_SPIKE_WARN_SIGMA,
  SPEND_SPIKE_WINDOW_DAYS,
  TEAM_SPEND_SPIKE_BASELINE_DAYS,
  TEAM_SPEND_SPIKE_CRITICAL_SIGMA,
  TEAM_SPEND_SPIKE_MIN_BASELINE_DAYS,
  TEAM_SPEND_SPIKE_TEAMS_IN_ALERT,
  TEAM_SPEND_SPIKE_WARN_SIGMA,
  TEAM_SPEND_SPIKE_WINDOW_DAYS,
  UNKNOWN_MODEL_SURGE_DEFAULT,
  UNKNOWN_MODEL_WINDOW_HOURS,
} from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';

import {
  downgradeableTriples,
  loadPolicyOverrides,
  resolveIngestModelPolicies,
} from '../lib/model-policy';
import { dispatchAlert } from '../lib/notify/channel';
import type { EmailConfig } from '../lib/notify/email';
import { buildAlertPayload } from '../lib/notify/payload';
import { type AlertEvaluation, applyAlertTransition } from './alert-transition';

type AlertsDb = Pick<
  PrismaClient,
  | 'jobRun'
  | 'alertRule'
  | 'alertEvent'
  | 'alertChannelConfig'
  | 'alertDeliveryLog'
  // routing_waste resolves the shared model policy, which lives in a
  // Prisma-managed table rather than the events hypertable.
  | 'modelPolicy'
> & {
  $queryRaw: PrismaClient['$queryRaw'];
};

type RuleRow = {
  id: string;
  name: string;
  params: unknown;
  ruleType: string;
  silencedUntil?: Date | null;
};

type Evaluation = AlertEvaluation;

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

async function evalSpendSpike(db: AlertsDb): Promise<Evaluation> {
  const now = Date.now();
  const windowStart = new Date(now - SPEND_SPIKE_WINDOW_DAYS * 86_400_000);
  const baselineStart = new Date(
    now - (SPEND_SPIKE_WINDOW_DAYS + SPEND_SPIKE_BASELINE_DAYS) * 86_400_000,
  );

  const rows = await db.$queryRaw<{ avg_cost: number; current: number; stddev_cost: number }[]>(
    Prisma.sql`
      WITH cur AS (
        SELECT COALESCE(SUM(s.total_cost_usd), 0) AS current
        FROM interactive_sessions s
        JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE s.started_at >= ${windowStart}
          AND COALESCE(vp.share_metadata_with_org, true) = true
      ),
      base AS (
        SELECT AVG(daily) AS avg_cost, STDDEV(daily) AS stddev_cost
        FROM (
          SELECT date_trunc('day', s.started_at) AS day, SUM(s.total_cost_usd) AS daily
          FROM interactive_sessions s
          JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
          LEFT JOIN visibility_policies vp ON vp.user_id = u.id
          WHERE s.started_at >= ${baselineStart} AND s.started_at < ${windowStart}
            AND COALESCE(vp.share_metadata_with_org, true) = true
          GROUP BY date_trunc('day', s.started_at)
        ) d
      )
      SELECT cur.current, base.avg_cost, base.stddev_cost FROM cur, base
    `,
  );

  const current = Number(rows[0]?.current ?? 0);
  const avg = Number(rows[0]?.avg_cost ?? 0);
  const stddev = Number(rows[0]?.stddev_cost ?? 0);
  if (avg <= 0 || stddev <= 0 || current <= avg + SPEND_SPIKE_WARN_SIGMA * stddev) {
    return null;
  }
  return {
    details: {
      avgCost: avg,
      currentCost: current,
      sigma: (current - avg) / stddev,
      stddev,
      windowDays: SPEND_SPIKE_WINDOW_DAYS,
    },
    severity: current > avg + SPEND_SPIKE_CRITICAL_SIGMA * stddev ? 'critical' : 'warn',
  };
}

async function evalHighErrorRate(db: AlertsDb): Promise<Evaluation> {
  const windowStart = new Date(Date.now() - ERROR_RATE_WINDOW_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ calls: number; errors: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(s.tool_call_count), 0) AS calls,
           COALESCE(SUM(s.tool_error_count), 0) AS errors
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${windowStart}
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const calls = Number(rows[0]?.calls ?? 0);
  const errors = Number(rows[0]?.errors ?? 0);
  if (calls < ERROR_RATE_MIN_CALLS || errors / calls <= ERROR_RATE_WARN) {
    return null;
  }
  return {
    details: { calls, errorRate: errors / calls, errors },
    severity: errors / calls > ERROR_RATE_CRITICAL ? 'critical' : 'warn',
  };
}

// How many model names an unknown-model alert names before deferring to
// /admin/price-tables for the rest. Enough to act on, short enough for a Slack
// line or an email subject's first paragraph.
const UNKNOWN_MODEL_NAMES_IN_ALERT = 5;

async function evalUnknownModelSurge(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const threshold = Number(paramsObject(params).threshold ?? UNKNOWN_MODEL_SURGE_DEFAULT);
  const windowStart = new Date(Date.now() - UNKNOWN_MODEL_WINDOW_HOURS * 3_600_000);
  // Visibility-scoped like the other evaluators: events from users who opted out
  // of org metadata sharing don't contribute to this org-aggregate signal.
  // Grouped by model, not just counted: "73 events were unpriced" leaves the
  // operator grepping ingest logs for which model to add to the table. The
  // model name is not individual-identifying, so naming it keeps the
  // aggregate-only guarantee alerts are held to.
  const rows = await db.$queryRaw<{ agent_type: string; c: number; model: string }[]>(Prisma.sql`
    SELECT e.agent_type, e.model, COUNT(*) AS c
    FROM interactive_events e
    JOIN users u ON u.id = e.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE e.ts >= ${windowStart}
      AND e.model IS NOT NULL
      AND e.cost_usd = 0
      AND e.input_tokens > 0
      AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY e.agent_type, e.model
    ORDER BY COUNT(*) DESC
  `);
  const count = rows.reduce((sum, r) => sum + Number(r.c), 0);
  if (count <= threshold) {
    return null;
  }
  return {
    details: {
      count,
      // Capped: the notification is a pointer to /admin/price-tables, which
      // carries the full list, not a replacement for it.
      models: rows.slice(0, UNKNOWN_MODEL_NAMES_IN_ALERT).map((r) => ({
        agentType: r.agent_type,
        count: Number(r.c),
        model: r.model,
      })),
      threshold,
      windowHours: UNKNOWN_MODEL_WINDOW_HOURS,
    },
    severity: 'warn',
  };
}

async function evalBudgetThreshold(db: AlertsDb, params: unknown): Promise<Evaluation> {
  // Inert until an admin configures a positive budget. parseBudgetThresholdParams
  // returns null for a missing/invalid budget and coerces a malformed windowDays
  // back to the default (never NaN), so a misconfigured rule stays silent rather
  // than firing or silently never-matching on an Invalid Date window.
  const p = parseBudgetThresholdParams(params);
  if (!p) {
    return null;
  }
  const windowStart = new Date(Date.now() - p.windowDays * 86_400_000);
  // Visibility-scoped like the other evaluators: users who opted out of org
  // metadata sharing don't contribute to this org-aggregate spend signal.
  const rows = await db.$queryRaw<{ spend: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(s.total_cost_usd), 0) AS spend
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${windowStart}
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const spend = Number(rows[0]?.spend ?? 0);
  const ratio = spend / p.budgetUsd;
  if (ratio < BUDGET_THRESHOLD_WARN_RATIO) {
    return null;
  }
  return {
    details: { budgetUsd: p.budgetUsd, ratio, spend, windowDays: p.windowDays },
    severity: ratio >= BUDGET_THRESHOLD_CRITICAL_RATIO ? 'critical' : 'warn',
  };
}

// Routing waste: premium-tier model spend on retrieval-only tool categories
// (fs_read / search) over the recent window — the same signal the /org/models
// routing recommendation surfaces, promoted to a proactive alert. Aggregate +
// visibility-scoped like the other evaluators. Fires on absolute wasted spend
// (params.thresholdUsd overrides the default); critical at 2x.
//
// P14-005 — WHAT THIS ALERT SUMS, AND WHY IT WAS DEAD.
//
// The join used to be `dm.model = e.model` on a row already restricted to
// `event_type = 'PostToolUse'`, summing that row's `cost_usd`. `events.model` is
// written only from an event's `llm` block (lib/insert-events.ts) and every
// producer attaches that block to a `Stop` event — so the predicate matched zero
// rows in real telemetry and this alert was armed and permanently silent, its
// arithmetic exercised only against seeded data. Nothing failed; it just never
// fired.
//
// The model therefore comes from the issuing turn's `Stop` row, reached through
// `parent_event_id` (the P14-003 turn linkage), and the dollars come from the
// tool row's `attributed_cost_usd` — the issuing turn's cost split across the
// calls it made (P14-004). `tool_category` stays on the tool row. That is the
// same redistribution the web surfaces perform; it is documented at length on
// `getOrgModelRoutingBreakdown` in apps/web/src/lib/org-queries.ts.
//
// NOT `downstream_cost_usd`: that is the *following* turn's input-side cost,
// priced with the following turn's model, so charging it to this turn's model
// would answer a different question at the wrong rates. The two columns are two
// lenses on the same dollars and are never summed.
//
// Coverage travels in `details`. A window whose events carry no turn linkage
// attributes nothing, and an alert that stays quiet for that reason looks
// identical to one that stays quiet because routing is healthy. `attributedCalls`
// / `callCount` let an operator tell those apart from the notification itself.
// Both are counts, so `details` stays numbers-only as documented on
// evalDisallowedModel below.
//
// Exported for the query-shape regression test only — see the sibling
// routing-waste-shape.test.ts. Its siblings stay module-private; this one carries
// a policy-derived join whose parameter count must not grow with the size of the
// price tables.
export async function evalRoutingWaste(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const threshold = Number(paramsObject(params).thresholdUsd ?? ROUTING_WASTE_DEFAULT_USD);
  if (!(threshold > 0)) {
    return null;
  }
  const windowStart = new Date(Date.now() - ROUTING_WASTE_WINDOW_DAYS * 86_400_000);
  // "Expensive" and "retrieval" are resolved per agent from the price tables and
  // the org's model policy — never a literal model substring. The previous
  // `ILIKE '%opus%'` silently matched nothing for the six non-Anthropic agents,
  // so this alert could not fire for most of the fleet.
  const policies = resolveIngestModelPolicies(await loadPolicyOverrides(db));
  const triples = downgradeableTriples(policies);
  if (triples.length === 0) {
    return null;
  }
  // Three parallel arrays through `unnest` rather than an inlined VALUES list.
  // The query text is then FIXED — three bind parameters regardless of how many
  // models are downgradeable — so Postgres can cache a plan for it. P12-012
  // regenerated the pi/omp/opencode tables from the models.dev catalog and took
  // them from 34 models to ~243 each, which grew this join from ~250 tuples to
  // ~1100; as a VALUES literal that is a differently-shaped query on every
  // policy edit, evaluated hourly.
  const agentTypes = triples.map((t) => t.agentType);
  const models = triples.map((t) => t.model);
  const categories = triples.map((t) => t.toolCategory);
  const rows = await db.$queryRaw<
    { attributed_calls: bigint; call_count: bigint; waste: string | null }[]
  >(Prisma.sql`
    SELECT SUM(tool.attributed_cost_usd)::text AS waste,
           COUNT(*) AS call_count,
           COUNT(*) FILTER (WHERE tool.attributed_cost_usd IS NOT NULL) AS attributed_calls
    FROM interactive_events tool
    JOIN users u ON u.id = tool.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    JOIN interactive_events turn
      ON turn.session_id  = tool.session_id
     AND turn.event_id    = tool.parent_event_id
     AND turn.ts         >= ${windowStart}
     AND turn.event_type  = 'Stop'
    JOIN unnest(${agentTypes}::text[], ${models}::text[], ${categories}::text[])
      AS dm(agent_type, model, tool_category)
      ON dm.agent_type = turn.agent_type
     AND dm.model = turn.model
     AND dm.tool_category = tool.tool_category
    WHERE tool.ts >= ${windowStart}
      AND tool.event_type = 'PostToolUse'
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const row = rows[0];
  // NULL means nothing in the window could be attributed — a gap in capture, not
  // $0 of waste. Either way there is no measured spend to fire on.
  const waste = row?.waste != null ? Number(row.waste) : null;
  if (waste === null || waste < threshold) {
    return null;
  }
  return {
    details: {
      attributedCalls: Number(row?.attributed_calls ?? 0),
      callCount: Number(row?.call_count ?? 0),
      thresholdUsd: threshold,
      wasteUsd: waste,
      windowDays: ROUTING_WASTE_WINDOW_DAYS,
    },
    severity: waste >= threshold * ROUTING_WASTE_CRITICAL_MULTIPLE ? 'critical' : 'warn',
  };
}

// Disallowed model (P10-005): spend in the recent window that went to models
// outside the org's allow-list for their agent_type. The allow-list is the
// P10-002 `model_policy` table — the same one apps/web edits and
// isModelAllowed() reads — so there is no second definition of "allowed".
//
// Done entirely in SQL (an INNER JOIN against model_policy) rather than reading
// the policy through the Prisma client: the rule has to be applied inside an
// aggregate over the events hypertable, and pulling every event into JS to test
// them one at a time is not an option.
//
// "Unconfigured means allowed" is enforced twice, both in the query:
//   1. the INNER JOIN drops every event whose agent_type has no model_policy row;
//   2. `COALESCE(array_length(mp.allowed_models, 1), 0) > 0` drops an agent whose
//      row exists but carries an empty allow-list — array_length returns NULL,
//      not 0, for an empty array, hence the COALESCE.
// Without both, enabling this rule on a fresh install would flag every session.
//
// `details` is deliberately numbers-only: dollars, counts, and the window. A
// model name is not individual-identifying, but the existing payload
// sanitization guarantee is easiest to keep honest if `details` never carries a
// string at all, so we report only how MANY distinct models were disallowed.
//
// Exported (unlike its sibling evaluators) so the governance suite can drive it
// directly with canned rows — see test/disallowed-model.test.ts.
export async function evalDisallowedModel(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const threshold = Number(paramsObject(params).thresholdUsd ?? DISALLOWED_MODEL_DEFAULT_USD);
  if (!(threshold > 0)) {
    return null;
  }
  const windowStart = new Date(Date.now() - DISALLOWED_MODEL_WINDOW_DAYS * 86_400_000);
  const rows = await db.$queryRaw<
    { distinct_models: number; event_count: number; session_count: number; spend: number }[]
  >(Prisma.sql`
    SELECT COALESCE(SUM(e.cost_usd), 0) AS spend,
           COUNT(*) AS event_count,
           COUNT(DISTINCT e.session_id) AS session_count,
           COUNT(DISTINCT e.model) AS distinct_models
    FROM interactive_events e
    JOIN users u ON u.id = e.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    JOIN model_policy mp ON mp.agent_type::text = e.agent_type
    WHERE e.ts >= ${windowStart}
      AND e.model IS NOT NULL
      AND COALESCE(array_length(mp.allowed_models, 1), 0) > 0
      AND NOT (e.model = ANY(mp.allowed_models))
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const spend = Number(rows[0]?.spend ?? 0);
  if (spend < threshold) {
    return null;
  }
  return {
    details: {
      distinctModels: Number(rows[0]?.distinct_models ?? 0),
      eventCount: Number(rows[0]?.event_count ?? 0),
      sessionCount: Number(rows[0]?.session_count ?? 0),
      spendUsd: spend,
      thresholdUsd: threshold,
      windowDays: DISALLOWED_MODEL_WINDOW_DAYS,
    },
    severity: spend >= threshold * DISALLOWED_MODEL_CRITICAL_MULTIPLE ? 'critical' : 'warn',
  };
}

// Autonomy surge (R9): the share of recent sessions running with no per-action
// human gate (bypass / dont_ask). A rising share is oversight erosion. Aggregate
// and visibility-scoped like the other evaluators — no individual is named.
async function evalAutonomySurge(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const warn = Number(paramsObject(params).threshold ?? AUTONOMY_SURGE_WARN);
  const critical = Number(paramsObject(params).criticalThreshold ?? AUTONOMY_SURGE_CRITICAL);
  const windowStart = new Date(Date.now() - AUTONOMY_SURGE_WINDOW_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ low_oversight: number; total: number }[]>(Prisma.sql`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE s.mode = ANY(${[...LOW_OVERSIGHT_MODES]}::text[])) AS low_oversight
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${windowStart}
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  const total = Number(rows[0]?.total ?? 0);
  const lowOversight = Number(rows[0]?.low_oversight ?? 0);
  if (total < AUTONOMY_SURGE_MIN_SESSIONS) {
    return null;
  }
  const share = lowOversight / total;
  if (share <= warn) {
    return null;
  }
  return {
    details: {
      lowOversightSessions: lowOversight,
      share,
      totalSessions: total,
      windowDays: AUTONOMY_SURGE_WINDOW_DAYS,
    },
    severity: share > critical ? 'critical' : 'warn',
  };
}

// Secret exposure surge: count of sessions whose shipped transcript matched a
// redaction class (packages/redaction) in the recent window. A spike in sessions
// shipping secrets is a security signal worth alerting on even without a
// configured budget. Aggregate and visibility-scoped like the other evaluators.
//
// `details` carries a capped list of redaction-class + count pairs. Redaction
// class names are categories (aws-access-key, github-token, …), not individuals,
// so naming them keeps the aggregate-only guarantee alerts are held to — the
// same reasoning as the model names in evalUnknownModelSurge.
async function evalSecretExposure(db: AlertsDb, params: unknown): Promise<Evaluation> {
  const threshold = Number(paramsObject(params).threshold ?? SECRET_EXPOSURE_DEFAULT_THRESHOLD);
  const windowStart = new Date(Date.now() - SECRET_EXPOSURE_WINDOW_DAYS * 86_400_000);
  const [totalRows, classRows] = await Promise.all([
    db.$queryRaw<{ c: number }[]>(Prisma.sql`
      SELECT COUNT(*) AS c
      FROM interactive_sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.started_at >= ${windowStart}
        AND array_length(s.redaction_flags, 1) > 0
        AND COALESCE(vp.share_metadata_with_org, true) = true
    `),
    db.$queryRaw<{ c: number; flag: string }[]>(Prisma.sql`
      SELECT flag, COUNT(DISTINCT s.session_id) AS c
      FROM interactive_sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      CROSS JOIN LATERAL unnest(s.redaction_flags) AS flag
      WHERE s.started_at >= ${windowStart}
        AND array_length(s.redaction_flags, 1) > 0
        AND COALESCE(vp.share_metadata_with_org, true) = true
      GROUP BY flag
      ORDER BY c DESC
    `),
  ]);
  const count = Number(totalRows[0]?.c ?? 0);
  if (count <= threshold) {
    return null;
  }
  return {
    details: {
      // `count` is distinct sessions with any redaction flag; the per-class
      // `sessionsWithClass` counts overlap (one session can carry several
      // classes), so their sum can exceed `count`. That is expected — the
      // threshold is on `count`, not on the sum.
      classes: classRows.slice(0, SECRET_EXPOSURE_CLASSES_IN_ALERT).map((r) => ({
        class: r.flag,
        sessionsWithClass: Number(r.c),
      })),
      count,
      threshold,
      windowDays: SECRET_EXPOSURE_WINDOW_DAYS,
    },
    severity: 'warn',
  };
}

// Team spend spike (C2): per-team z-score on daily spend over a trailing
// baseline. Same statistical approach as the org-wide evalSpendSpike, but
// scoped to each team's own daily spend series. The rule fires when ANY team
// exceeds the warn sigma; the details carry a capped list of spiking teams.
//
// Both the current window and the baseline are per-day statistics (AVG of
// daily_cost), so the z-score compares like-for-like: a team whose average
// daily spend in the recent window is >2.5σ above its baseline daily mean.
// This avoids the scale mismatch of comparing a 7-day sum to a 1-day mean.
//
// `details` carries team slug + stats (currentCost = avg daily cost in the
// recent window, avgCost = baseline daily mean, stddev, sigma). Team slugs are
// GitHub-derived org identifiers, not individuals — the same category of
// identifier as the model names in evalUnknownModelSurge, so naming them keeps
// the aggregate-only guarantee alerts are held to.
//
// Known limitation: a user in multiple teams has their spend counted in each
// team (the join goes through team_members without allocation). This is the
// same pattern as getCostByTeam / getTeamSpendForecast — team spend is
// overlapping, not a partition of org spend. A user with high spend can spike
// multiple teams simultaneously, which is acceptable for an anomaly signal
// (it surfaces the teams affected, not a budget attribution).
async function evalTeamSpendSpike(db: AlertsDb): Promise<Evaluation> {
  const now = Date.now();
  const windowStart = new Date(now - TEAM_SPEND_SPIKE_WINDOW_DAYS * 86_400_000);
  const baselineStart = new Date(
    now - (TEAM_SPEND_SPIKE_WINDOW_DAYS + TEAM_SPEND_SPIKE_BASELINE_DAYS) * 86_400_000,
  );

  // One row per team with current-window average daily spend, baseline
  // avg/stddev of daily spend, and the count of baseline days (to filter teams
  // with too little history). The baseline and current windows are disjoint,
  // like evalSpendSpike. Both `cur` and `base` are per-day statistics, so the
  // z-score compares like-for-like (daily avg vs daily avg + daily stddev).
  const rows = await db.$queryRaw<
    {
      avg_cost: number;
      baseline_days: number;
      current: number;
      stddev_cost: number;
      team_slug: string;
    }[]
  >(Prisma.sql`
    WITH team_daily AS (
      SELECT
        t.github_slug                           AS team_slug,
        date_trunc('day', s.started_at)         AS day,
        SUM(s.total_cost_usd)                   AS daily_cost
      FROM interactive_sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      JOIN team_members tm ON tm.user_id = u.id AND tm.left_at IS NULL
      JOIN teams t ON t.id = tm.team_id
      WHERE s.started_at >= ${baselineStart}
        AND COALESCE(vp.share_metadata_with_org, true) = true
      GROUP BY t.id, t.github_slug, date_trunc('day', s.started_at)
    ),
    cur AS (
      SELECT team_slug, AVG(daily_cost) AS current
      FROM team_daily
      WHERE day >= ${windowStart}
      GROUP BY team_slug
    ),
    base AS (
      SELECT team_slug,
             AVG(daily_cost)   AS avg_cost,
             STDDEV(daily_cost) AS stddev_cost,
             COUNT(*)          AS baseline_days
      FROM team_daily
      WHERE day >= ${baselineStart} AND day < ${windowStart}
      GROUP BY team_slug
    )
    SELECT cur.team_slug, cur.current, base.avg_cost, base.stddev_cost, base.baseline_days
    FROM cur JOIN base ON base.team_slug = cur.team_slug
  `);

  const spiking = rows
    .filter(
      (r) =>
        r.baseline_days >= TEAM_SPEND_SPIKE_MIN_BASELINE_DAYS &&
        Number(r.avg_cost) > 0 &&
        Number(r.stddev_cost) > 0 &&
        Number(r.current) >
          Number(r.avg_cost) + TEAM_SPEND_SPIKE_WARN_SIGMA * Number(r.stddev_cost),
    )
    .map((r) => {
      const current = Number(r.current);
      const avg = Number(r.avg_cost);
      const stddev = Number(r.stddev_cost);
      const sigma = (current - avg) / stddev;
      return {
        avgCost: avg,
        currentCost: current,
        sigma,
        stddev,
        teamSlug: r.team_slug,
      };
    })
    .sort((a, b) => b.sigma - a.sigma);

  if (spiking.length === 0) {
    return null;
  }

  const hasCritical = spiking.some((t) => t.sigma >= TEAM_SPEND_SPIKE_CRITICAL_SIGMA);

  return {
    details: {
      teams: spiking.slice(0, TEAM_SPEND_SPIKE_TEAMS_IN_ALERT),
      windowDays: TEAM_SPEND_SPIKE_WINDOW_DAYS,
    },
    severity: hasCritical ? 'critical' : 'warn',
  };
}

async function evaluateRule(db: AlertsDb, rule: RuleRow): Promise<Evaluation> {
  switch (rule.ruleType) {
    case 'spend_spike':
      return evalSpendSpike(db);
    case 'high_error_rate':
      return evalHighErrorRate(db);
    case 'unknown_model_surge':
      return evalUnknownModelSurge(db, rule.params);
    case 'budget_threshold':
      return evalBudgetThreshold(db, rule.params);
    case 'routing_waste':
      return evalRoutingWaste(db, rule.params);
    case 'autonomy_surge':
      return evalAutonomySurge(db, rule.params);
    case 'disallowed_model':
      return evalDisallowedModel(db, rule.params);
    case 'secret_exposure':
      return evalSecretExposure(db, rule.params);
    case 'team_spend_spike':
      return evalTeamSpendSpike(db);
    default:
      // Any future types: unimplemented evaluators never fire rather than throwing,
      // so one bad rule can't fail the whole sweep.
      return null;
  }
}

/**
 * Scheduled alert evaluation (P9-001). Evaluates each enabled alert_rule against
 * the aggregates and records firing/resolving transitions in alert_events. Uses
 * the same statistical thresholds as the dashboard's getAnomalies (shared via
 * @ai-agents-observability/schemas) so banners and alerts never disagree.
 */
export async function runEvaluateAlerts(
  db: AlertsDb,
  logger?: Logger,
  appBaseUrl = '',
  emailConfig?: EmailConfig,
): Promise<void> {
  const jobName = 'evaluate-alerts';
  const startedAt = new Date();

  const lock = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;
  if (!lock[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({ data: { jobName, startedAt, status: 'running' } });
    jobRunId = jobRun.id;

    const rules = (await db.alertRule.findMany({ where: { enabled: true } })) as RuleRow[];
    // Load notification channels once; only newly-FIRED transitions notify (no
    // spam on still-firing or resolved). Delivery is best-effort and never throws.
    const channels = await db.alertChannelConfig.findMany({ where: { enabled: true } });
    let fired = 0;
    let resolved = 0;
    const now = Date.now();
    for (const rule of rules) {
      try {
        const silenced = rule.silencedUntil != null && rule.silencedUntil.getTime() > now;
        const evaluation = await evaluateRule(db, rule);
        // R7 (HITL): while silenced, suppress NEW firings and notifications (avoids
        // alert fatigue on known issues) — but still let a cleared condition resolve
        // an already-open event, so a self-corrected alert doesn't linger "active"
        // for the whole silence window.
        if (silenced && evaluation) {
          continue;
        }
        const outcome = await applyAlertTransition(db, rule.id, evaluation);
        if (outcome === 'fired') {
          fired++;
          if (evaluation && channels.length > 0) {
            const payload = buildAlertPayload(
              rule,
              { details: evaluation.details, firedAt: new Date(), severity: evaluation.severity },
              appBaseUrl,
            );
            await dispatchAlert(db, channels, payload, { emailConfig, logger });
          }
        } else if (outcome === 'resolved') {
          resolved++;
        }
      } catch (err) {
        logger?.warn({ err, ruleId: rule.id }, 'Alert rule evaluation failed');
      }
    }

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });
    logger?.info({ fired, jobName, resolved, rules: rules.length }, 'Alert evaluation complete');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Alert evaluation failed');
    if (jobRunId !== undefined) {
      await db.jobRun
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
