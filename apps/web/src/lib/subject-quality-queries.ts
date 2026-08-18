import { Prisma } from '@ai-agents-observability/db';
import {
  MCP_EFFECTIVENESS_VERSION,
  SKILL_EFFECTIVENESS_VERSION,
  skillSubjectId,
} from '@ai-agents-observability/schemas';

import { getPrisma } from './prisma';
import { interactiveEvents, interactiveOnly } from './run-kind';
import { fisherExactTwoTailed } from './stats';

/**
 * Skill and MCP-server effectiveness (P13-004).
 *
 * `/org/skills` and `/org/mcp` already report **usage**. This module reports
 * **quality**: for each skill and MCP server, how the sessions that invoked it
 * compare to sessions that did not, on friction and on PR outcome, plus the
 * server's own error rate. `DESIGN_DOC.md` §15 asks for exactly this feedback
 * loop — "skills with high invocation but low downstream tool success could be
 * flagged for revision" — and this is the one workstream-B surface a human can
 * act on directly: a skill author can fix the thing being measured.
 *
 * Three rules govern everything here, and each exists because the naive version
 * of this feature is actively harmful:
 *
 * 1. **The comparison is matched on session shape.** A skill invoked mostly on
 *    debugging sessions compared against the whole population is comparing
 *    debugging to everything, and would report the skill as terrible. The
 *    comparison pool for each subject is restricted to the shapes that subject
 *    actually appears in. It is a *partial* control — repo, task difficulty and
 *    self-selection all survive it — which is why the panel copy says so.
 * 2. **Comparisons are volume-gated and significance-tested**, through the
 *    P11-004 Fisher's exact implementation in `stats.ts`. There is one
 *    statistics path in this app and this is not a second one.
 * 3. **Association, never causation.** Nothing here returns a verdict field, a
 *    ranking, or a "good/bad" label. It returns rates, sample sizes and
 *    p-values, and the rendering copy carries the caveat.
 *
 * Subjects are org-level artifacts. There is deliberately no per-developer
 * breakdown: the question is "is this skill good", never "is this developer good
 * at using it".
 */

/**
 * Sessions needed on *each* side before a friction or outcome comparison is
 * reported at all. Below this the comparison is not weak, it is noise wearing a
 * number's clothing — the failure mode `DESIGN_DOC.md` §10.6 exists to prevent.
 */
export const SUBJECT_MIN_SESSIONS_PER_ARM = 10;

/** Calls needed before an error rate is reported for a subject. */
export const SUBJECT_MIN_CALLS = 20;

/** Conventional threshold; reported alongside the p-value, never instead of it. */
export const SUBJECT_SIGNIFICANCE_ALPHA = 0.05;

/** How far back a subject must have been silent to be a deprecation candidate. */
const DEPRECATION_LOOKBACK_DAYS = 180;

/** One arm of a matched comparison — the sessions that did, or did not, invoke. */
export type SubjectArm = {
  ciClean: number;
  ciKnown: number;
  medianFriction: number | null;
  mergedPrs: number;
  revertedPrs: number;
  sessionCount: number;
};

export type SubjectQualityRow = {
  /** Calls made in the same session at or after the subject's first invocation. */
  downstreamCalls: number;
  downstreamErrors: number;
  distinctUsers: number;
  invocations: number;
  /** `skill` / `slash` for skills; always `mcp_server` for MCP rows. */
  kind: string;
  name: string;
  /** Sessions that never invoked the subject, matched on shape. */
  without: SubjectArm;
  /** Sessions that invoked the subject at least once. */
  with: SubjectArm;
};

export type SubjectComparison = {
  /** True when both arms clear `SUBJECT_MIN_SESSIONS_PER_ARM`. */
  measurable: boolean;
  outcome: 'reverted' | 'ciFailed';
  /** Null when not measurable — never a p-value of 1, which reads as evidence. */
  pValue: number | null;
  rateWith: number | null;
  rateWithout: number | null;
};

/**
 * Fisher's exact on a subject's outcome rates, with vs without, on the matched
 * pool. Returns `measurable: false` rather than a p-value when either arm is too
 * small — an underpowered p-value next to a rate is read as a verdict, and the
 * whole point of gating is that "not yet measurable" is the honest answer.
 *
 * Pure, so the gate and the test are unit-testable without a database.
 */
export function compareSubjectOutcomes(row: SubjectQualityRow): SubjectComparison[] {
  const gated =
    row.with.sessionCount < SUBJECT_MIN_SESSIONS_PER_ARM ||
    row.without.sessionCount < SUBJECT_MIN_SESSIONS_PER_ARM;

  const arms: {
    key: SubjectComparison['outcome'];
    total: (a: SubjectArm) => number;
    hit: (a: SubjectArm) => number;
  }[] = [
    { hit: (a) => a.revertedPrs, key: 'reverted', total: (a) => a.mergedPrs },
    { hit: (a) => a.ciKnown - a.ciClean, key: 'ciFailed', total: (a) => a.ciKnown },
  ];

  return arms.map(({ hit, key, total }) => {
    const withTotal = total(row.with);
    const withoutTotal = total(row.without);
    const withHit = hit(row.with);
    const withoutHit = hit(row.without);
    const measurable =
      !gated &&
      withTotal >= SUBJECT_MIN_SESSIONS_PER_ARM &&
      withoutTotal >= SUBJECT_MIN_SESSIONS_PER_ARM;
    return {
      measurable,
      outcome: key,
      pValue: measurable
        ? fisherExactTwoTailed(withHit, withTotal - withHit, withoutHit, withoutTotal - withoutHit)
        : null,
      rateWith: withTotal > 0 ? withHit / withTotal : null,
      rateWithout: withoutTotal > 0 ? withoutHit / withoutTotal : null,
    };
  });
}

/** Error rate over downstream calls, or null below the call floor. */
export function subjectErrorRate(row: SubjectQualityRow): number | null {
  return row.downstreamCalls < SUBJECT_MIN_CALLS
    ? null
    : row.downstreamErrors / row.downstreamCalls;
}

// ── SQL fragments ────────────────────────────────────────────────────────────

function userFilter(visibleIds: string[]): Prisma.Sql {
  return Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
}

/**
 * The scoped session population: interactive, visible, in-window, and *scored*
 * (a session with no `shape_label` cannot be matched on shape, and including it
 * unmatched would reintroduce the confound the matching exists to remove).
 */
function scopedSessions(visibleIds: string[], since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT s.session_id, s.shape_label, s.friction_score, s.pr_ci_status
    FROM sessions s
    WHERE ${interactiveOnly('s')}
      AND s.user_id IN (${userFilter(visibleIds)})
      AND s.started_at >= ${since}
      AND s.shape_label IS NOT NULL
  `;
}

/** Merge / revert facts per session, from the linked pull requests. */
const PR_OUTCOME_SQL = Prisma.sql`
  SELECT l.session_id,
         bool_or(pr.state = 'MERGED')            AS merged,
         bool_or(pr.reverted_at IS NOT NULL)     AS reverted
  FROM session_pr_links l
  JOIN pull_requests pr ON pr.repo_id = l.repo_id AND pr.pr_number = l.pr_number
  GROUP BY l.session_id
`;

/**
 * Per-session invocations of each skill / slash command.
 *
 * `<agent>:<tool>` naming is respected by *not* interfering with it: skill names
 * are stored raw and the agent prefix is applied at display time (P8-001), so a
 * skill of the same name under two agents aggregates here exactly as the rest of
 * the app aggregates it.
 */
function skillInvocations(visibleIds: string[], since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(e.skill_name, e.slash_command)                            AS name,
           CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END   AS kind,
           e.session_id, e.user_id,
           MIN(e.ts)                                                          AS first_ts,
           COUNT(*)                                                           AS invocations
    FROM events e
    WHERE ${interactiveEvents('e')}
      AND e.user_id IN (${userFilter(visibleIds)})
      AND e.ts >= ${since}
      AND (e.skill_name IS NOT NULL OR e.slash_command IS NOT NULL)
    GROUP BY 1, 2, 3, 4
  `;
}

/** Per-session invocations of each MCP server. */
function mcpInvocations(visibleIds: string[], since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT e.mcp_server                AS name,
           'mcp_server'                AS kind,
           e.session_id, e.user_id,
           MIN(e.ts)                   AS first_ts,
           COUNT(*)                    AS invocations
    FROM events e
    WHERE ${interactiveEvents('e')}
      AND e.user_id IN (${userFilter(visibleIds)})
      AND e.ts >= ${since}
      AND e.event_type = 'PostToolUse'
      AND e.mcp_server IS NOT NULL
    GROUP BY 1, 2, 3, 4
  `;
}

type ProfileRow = {
  distinct_users: bigint;
  downstream_calls: bigint;
  downstream_errors: bigint;
  invocations: bigint;
  kind: string;
  name: string;
};

type ArmRow = {
  ci_clean: bigint;
  ci_known: bigint;
  invoked: boolean;
  kind: string;
  median_friction: number | null;
  merged_prs: bigint;
  name: string;
  reverted_prs: bigint;
  session_count: bigint;
};

const EMPTY_ARM: SubjectArm = {
  ciClean: 0,
  ciKnown: 0,
  medianFriction: null,
  mergedPrs: 0,
  revertedPrs: 0,
  sessionCount: 0,
};

/**
 * Shared engine for both subject kinds: the only thing that differs between a
 * skill and an MCP server is how a session is judged to have "invoked" it, so
 * that is the only thing parameterized. One definition means the matching rule
 * and the volume gate cannot drift apart between the two pages.
 */
async function subjectQuality(
  visibleIds: string[],
  since: Date,
  invocations: Prisma.Sql,
  limit: number,
): Promise<SubjectQualityRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const prisma = getPrisma();
  const scoped = scopedSessions(visibleIds, since);

  // Profile: volume plus the downstream tool-error rate — calls made in the same
  // session at or after the subject's first invocation. "Downstream" is the
  // honest unit: a skill cannot be blamed for errors that preceded it.
  const profiles = await prisma.$queryRaw<ProfileRow[]>(Prisma.sql`
    WITH scoped AS (${scoped}),
    invocation AS (${invocations}),
    subject AS (
      SELECT i.name, i.kind,
             SUM(i.invocations)::bigint         AS invocations,
             COUNT(DISTINCT i.user_id)::bigint  AS distinct_users
      FROM invocation i
      JOIN scoped sc ON sc.session_id = i.session_id
      GROUP BY 1, 2
      ORDER BY invocations DESC
      LIMIT ${limit}
    ),
    downstream AS (
      SELECT i.name, i.kind,
             COUNT(*)::bigint AS calls,
             COUNT(*) FILTER (
               WHERE e.tool_exit_status IS NOT NULL
                 AND e.tool_exit_status <> 0
                 AND e.tool_was_denied IS DISTINCT FROM true
             )::bigint AS errors
      FROM invocation i
      JOIN scoped sc ON sc.session_id = i.session_id
      JOIN events e ON e.session_id = i.session_id AND e.ts >= i.first_ts
      WHERE ${interactiveEvents('e')}
        AND e.event_type = 'PostToolUse'
        AND e.tool_name IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT s.name, s.kind, s.invocations, s.distinct_users,
           COALESCE(d.calls, 0)  AS downstream_calls,
           COALESCE(d.errors, 0) AS downstream_errors
    FROM subject s
    LEFT JOIN downstream d ON d.name = s.name AND d.kind = s.kind
    ORDER BY s.invocations DESC
  `);

  if (profiles.length === 0) {
    return [];
  }

  // Matched arms. `shape_mix` is the match: the comparison pool for a subject is
  // the set of shapes that subject actually appears in, so a skill used only on
  // debugging sessions is compared against debugging sessions.
  const arms = await prisma.$queryRaw<ArmRow[]>(Prisma.sql`
    WITH scoped AS (${scoped}),
    invocation AS (${invocations}),
    pr_outcome AS (${PR_OUTCOME_SQL}),
    subject AS (
      SELECT i.name, i.kind, SUM(i.invocations)::bigint AS invocations
      FROM invocation i
      JOIN scoped sc ON sc.session_id = i.session_id
      GROUP BY 1, 2
      ORDER BY invocations DESC
      LIMIT ${limit}
    ),
    shape_mix AS (
      SELECT s.name, s.kind, sc.shape_label
      FROM subject s
      JOIN invocation i  ON i.name = s.name AND i.kind = s.kind
      JOIN scoped sc     ON sc.session_id = i.session_id
      GROUP BY 1, 2, 3
    ),
    paired AS (
      SELECT sm.name, sm.kind, sc.session_id, sc.friction_score, sc.pr_ci_status,
             (i.session_id IS NOT NULL) AS invoked
      FROM shape_mix sm
      JOIN scoped sc    ON sc.shape_label = sm.shape_label
      LEFT JOIN invocation i
             ON i.name = sm.name AND i.kind = sm.kind AND i.session_id = sc.session_id
    )
    SELECT p.name, p.kind, p.invoked,
           COUNT(*)::bigint                                                        AS session_count,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.friction_score)           AS median_friction,
           COUNT(*) FILTER (WHERE po.merged)::bigint                               AS merged_prs,
           COUNT(*) FILTER (WHERE po.reverted)::bigint                             AS reverted_prs,
           COUNT(*) FILTER (WHERE upper(p.pr_ci_status) = 'SUCCESS')::bigint       AS ci_clean,
           COUNT(*) FILTER (WHERE upper(p.pr_ci_status) IN ('SUCCESS', 'FAILURE'))::bigint AS ci_known
    FROM paired p
    LEFT JOIN pr_outcome po ON po.session_id = p.session_id
    GROUP BY p.name, p.kind, p.invoked
  `);

  const armIndex = new Map<string, SubjectArm>();
  for (const a of arms) {
    armIndex.set(`${a.kind}\u0000${a.name}\u0000${a.invoked}`, {
      ciClean: Number(a.ci_clean),
      ciKnown: Number(a.ci_known),
      medianFriction: a.median_friction === null ? null : Number(a.median_friction),
      mergedPrs: Number(a.merged_prs),
      revertedPrs: Number(a.reverted_prs),
      sessionCount: Number(a.session_count),
    });
  }

  return profiles.map((p) => ({
    distinctUsers: Number(p.distinct_users),
    downstreamCalls: Number(p.downstream_calls),
    downstreamErrors: Number(p.downstream_errors),
    invocations: Number(p.invocations),
    kind: p.kind,
    name: p.name,
    with: armIndex.get(`${p.kind}\u0000${p.name}\u0000true`) ?? EMPTY_ARM,
    without: armIndex.get(`${p.kind}\u0000${p.name}\u0000false`) ?? EMPTY_ARM,
  }));
}

export async function getSkillQuality(
  visibleIds: string[],
  since: Date,
  limit = 25,
): Promise<SubjectQualityRow[]> {
  return subjectQuality(visibleIds, since, skillInvocations(visibleIds, since), limit);
}

export async function getMcpQuality(
  visibleIds: string[],
  since: Date,
  limit = 25,
): Promise<SubjectQualityRow[]> {
  return subjectQuality(visibleIds, since, mcpInvocations(visibleIds, since), limit);
}

// ── MCP failure split ────────────────────────────────────────────────────────

export type McpFailureRow = {
  calls: number;
  /** Non-zero exit that still returned a payload — the tool itself failed. */
  toolErrors: number;
  mcpServer: string;
  p95DurationMs: number | null;
  /** Non-zero exit with no payload at all — the server never answered. */
  unavailable: number;
};

/**
 * Splits MCP failures into "the server never answered" and "the tool returned an
 * error", because they need different owners: the first is an operations
 * problem for whoever runs the server, the second is a bug for whoever wrote the
 * tool.
 *
 * The split is inferred, and the inference is stated here rather than hidden: a
 * call that exits non-zero having produced **no output at all** did not reach a
 * tool, whereas one that produced a payload did. `tool_exit_status IS NULL` is a
 * third state — the adapter reported no status — and is counted in neither.
 */
export async function getMcpFailureSplit(
  visibleIds: string[],
  since: Date,
): Promise<McpFailureRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const rows = await getPrisma().$queryRaw<
    {
      calls: bigint;
      mcp_server: string;
      p95_duration_ms: number | null;
      tool_errors: bigint;
      unavailable: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      e.mcp_server,
      COUNT(*)::bigint AS calls,
      COUNT(*) FILTER (
        WHERE e.tool_exit_status IS NOT NULL AND e.tool_exit_status <> 0
          AND e.tool_was_denied IS DISTINCT FROM true
          AND COALESCE(e.tool_output_bytes, 0) = 0
      )::bigint AS unavailable,
      COUNT(*) FILTER (
        WHERE e.tool_exit_status IS NOT NULL AND e.tool_exit_status <> 0
          AND e.tool_was_denied IS DISTINCT FROM true
          AND COALESCE(e.tool_output_bytes, 0) > 0
      )::bigint AS tool_errors,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.tool_duration_ms) AS p95_duration_ms
    FROM events e
    WHERE ${interactiveEvents('e')}
      AND e.user_id IN (${userFilter(visibleIds)})
      AND e.ts >= ${since}
      AND e.event_type = 'PostToolUse'
      AND e.mcp_server IS NOT NULL
    GROUP BY e.mcp_server
    ORDER BY calls DESC
  `);

  return rows.map((r) => ({
    calls: Number(r.calls),
    mcpServer: r.mcp_server,
    p95DurationMs: r.p95_duration_ms === null ? null : Math.round(Number(r.p95_duration_ms)),
    toolErrors: Number(r.tool_errors),
    unavailable: Number(r.unavailable),
  }));
}

// ── Deprecation candidates ───────────────────────────────────────────────────

export type DeprecationCandidate = {
  historicInvocations: number;
  kind: string;
  lastUsedAt: Date;
  name: string;
};

/**
 * Subjects that were used before the window and not at all inside it.
 *
 * Reported rather than omitted, per `OPPORTUNITIES.md` §3.3: a skill nobody
 * invokes any more is a maintenance liability, and a list that silently drops it
 * makes the liability invisible. This reports the signal; retiring the thing is
 * a human decision, and the platform never makes it.
 */
export async function getDeprecationCandidates(
  visibleIds: string[],
  since: Date,
): Promise<DeprecationCandidate[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const users = userFilter(visibleIds);
  const rows = await getPrisma().$queryRaw<
    { historic: bigint; kind: string; last_used_at: Date; name: string }[]
  >(Prisma.sql`
    WITH historic AS (
      SELECT COALESCE(e.skill_name, e.slash_command)                           AS name,
             CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END  AS kind,
             COUNT(*)::bigint AS invocations,
             MAX(e.ts)        AS last_used_at
      FROM events e
      WHERE ${interactiveEvents('e')}
        AND e.user_id IN (${users})
        AND e.ts >= NOW() - (${DEPRECATION_LOOKBACK_DAYS} * INTERVAL '1 day')
        AND e.ts < ${since}
        AND (e.skill_name IS NOT NULL OR e.slash_command IS NOT NULL)
      GROUP BY 1, 2
      UNION ALL
      SELECT e.mcp_server, 'mcp_server', COUNT(*)::bigint, MAX(e.ts)
      FROM events e
      WHERE ${interactiveEvents('e')}
        AND e.user_id IN (${users})
        AND e.ts >= NOW() - (${DEPRECATION_LOOKBACK_DAYS} * INTERVAL '1 day')
        AND e.ts < ${since}
        AND e.event_type = 'PostToolUse'
        AND e.mcp_server IS NOT NULL
      GROUP BY 1, 2
    ),
    recent AS (
      SELECT DISTINCT COALESCE(e.skill_name, e.slash_command)                  AS name,
             CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END  AS kind
      FROM events e
      WHERE ${interactiveEvents('e')}
        AND e.user_id IN (${users})
        AND e.ts >= ${since}
        AND (e.skill_name IS NOT NULL OR e.slash_command IS NOT NULL)
      UNION
      SELECT DISTINCT e.mcp_server, 'mcp_server'
      FROM events e
      WHERE ${interactiveEvents('e')}
        AND e.user_id IN (${users})
        AND e.ts >= ${since}
        AND e.event_type = 'PostToolUse'
        AND e.mcp_server IS NOT NULL
    )
    SELECT h.name, h.kind, h.invocations AS historic, h.last_used_at
    FROM historic h
    LEFT JOIN recent r ON r.name = h.name AND r.kind = h.kind
    WHERE r.name IS NULL
    ORDER BY h.invocations DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    historicInvocations: Number(r.historic),
    kind: r.kind,
    lastUsedAt: r.last_used_at,
    name: r.name,
  }));
}

/**
 * The stored series behind a subject's error rate (P13-013).
 *
 * The panels above compute their comparisons **on read**, because the window is
 * a URL parameter and the matched arms depend on it. That is the right shape for
 * a comparison and the wrong shape for a trend: a rate computed on read exists
 * only while the page is open.
 *
 * `compute-subject-scores` writes one `scores` row per subject per day-bucketed
 * window, so this reads a real series rather than recomputing one. Until
 * P13-013 the job overwrote a single row every night and there was no series to
 * read — which is why this function could not have existed before.
 *
 * run-kind-exempt: reads `scores`, not `sessions` or `events`. The rows were
 * written by a job that already applied the filter.
 */
export type SubjectSeriesPoint = { periodStart: Date; value: number };

/** Points below this render no sparkline. Two points is a line, not a trend. */
export const SUBJECT_TREND_MIN_POINTS = 3;

export async function getSubjectScoreSeries(
  subjectType: 'SKILL' | 'MCP_SERVER',
  // Takes the panel's own rows rather than pre-shaped ids: `subject_id` is
  // `kind:name` for skills and a bare name for MCP servers, and five call sites
  // each doing that conversion is five chances to get it subtly wrong.
  rows: readonly { kind: string; name: string }[],
): Promise<Map<string, SubjectSeriesPoint[]>> {
  const series = new Map<string, SubjectSeriesPoint[]>();
  const subjectIds = rows.map((r) =>
    r.kind === 'mcp_server'
      ? r.name
      : skillSubjectId(r.kind === 'skill' ? 'skill' : 'slash', r.name),
  );
  if (subjectIds.length === 0) {
    return series;
  }

  const scoreRows = await getPrisma().score.findMany({
    orderBy: { periodStart: 'asc' },
    select: { periodStart: true, subjectId: true, value: true },
    where: {
      // Only the current version: a series that silently spans a scorer change
      // is two different measurements drawn as one line, which is exactly what
      // versioning the scorer was meant to prevent.
      scorerName: subjectType === 'SKILL' ? 'skill_effectiveness' : 'mcp_effectiveness',
      scorerVersion:
        subjectType === 'SKILL' ? SKILL_EFFECTIVENESS_VERSION : MCP_EFFECTIVENESS_VERSION,
      subjectId: { in: [...subjectIds] },
      subjectType,
      value: { not: null },
    },
  });

  for (const r of scoreRows) {
    if (r.periodStart === null || r.value === null) {
      continue;
    }
    const points = series.get(r.subjectId) ?? [];
    points.push({ periodStart: r.periodStart, value: r.value });
    series.set(r.subjectId, points);
  }
  return series;
}
