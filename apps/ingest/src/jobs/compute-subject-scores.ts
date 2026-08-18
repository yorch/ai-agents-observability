import { Prisma } from '@ai-agents-observability/db';
import { type ScoreInput, skillSubjectId } from '@ai-agents-observability/schemas';
import type { Logger } from 'pino';
import { interactiveEvents } from '../lib/run-kind';
import { scoreUpserts } from '../lib/scores';
import { type JobRawDb, withJobRun } from './job-run';

/**
 * Skill and MCP-server score rows (P13-004).
 *
 * `/org/skills` and `/org/mcp` compute their comparison panels on read, because
 * the window is a URL parameter and the matched arms depend on it. This job
 * exists for the other half of the acceptance criterion: **a trend**. A rate
 * computed on read exists only while the page is open; a `scores` row keyed by
 * `subject_type: SKILL` / `MCP_SERVER` persists, so "this server's error rate
 * has been climbing for three weeks" is a query rather than a memory, and
 * P13-006 has something to validate a projection against.
 *
 * The persisted value is deliberately the **narrowest** of the read-time
 * figures: the downstream tool-error rate, which needs no matched control group
 * and is therefore the one number that means the same thing every night. The
 * friction and PR-outcome comparisons stay on the read path with their volume
 * gates and their caveat copy attached — persisting a comparison would strip it
 * from both.
 *
 * Volumes travel in `metadata` so a later reader can tell whether a stored rate
 * rested on 20 calls or 20,000.
 */

type DbWithRaw = JobRawDb;

/** Trailing window the nightly figure describes. */
const WINDOW_DAYS = 30;

/**
 * Calls needed before a rate is written at all. Mirrors the read surface's
 * `SUBJECT_MIN_CALLS`: a subject invoked five times has no error rate, and a
 * stored row saying otherwise would outlive the caveat that should accompany it.
 */
const MIN_CALLS = 20;

type SkillRow = {
  distinct_users: bigint;
  downstream_calls: bigint;
  downstream_errors: bigint;
  invocations: bigint;
  kind: string;
  name: string;
  session_count: bigint;
};

type McpRow = {
  calls: bigint;
  distinct_users: bigint;
  mcp_server: string;
  session_count: bigint;
  tool_errors: bigint;
  unavailable: bigint;
};

/**
 * Skills and slash commands, with the tool-error rate of everything the session
 * did at or after the first invocation. Interactive runs only: a CI run has no
 * human choosing to invoke a skill, so including it would measure the harness.
 */
async function skillProfiles(db: Pick<DbWithRaw, '$queryRaw'>): Promise<SkillRow[]> {
  return db.$queryRaw<SkillRow[]>(Prisma.sql`
    WITH invocation AS (
      SELECT COALESCE(e.skill_name, e.slash_command)                           AS name,
             CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END  AS kind,
             e.session_id, e.user_id,
             MIN(e.ts)  AS first_ts,
             COUNT(*)   AS invocations
      FROM events e
      WHERE ${interactiveEvents('e')}
        AND e.ts >= NOW() - (${WINDOW_DAYS} * INTERVAL '1 day')
        AND (e.skill_name IS NOT NULL OR e.slash_command IS NOT NULL)
      GROUP BY 1, 2, 3, 4
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
      JOIN events e ON e.session_id = i.session_id AND e.ts >= i.first_ts
      WHERE ${interactiveEvents('e')}
        AND e.event_type = 'PostToolUse'
        AND e.tool_name IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT i.name, i.kind,
           SUM(i.invocations)::bigint        AS invocations,
           COUNT(DISTINCT i.user_id)::bigint AS distinct_users,
           COUNT(DISTINCT i.session_id)::bigint AS session_count,
           COALESCE(MAX(d.calls), 0)         AS downstream_calls,
           COALESCE(MAX(d.errors), 0)        AS downstream_errors
    FROM invocation i
    LEFT JOIN downstream d ON d.name = i.name AND d.kind = i.kind
    GROUP BY i.name, i.kind
  `);
}

/**
 * MCP servers, with failures split by whether the call produced a payload —
 * a call that exits non-zero having returned nothing never reached a tool, and
 * that is the server's problem rather than the tool author's. Both counts ride
 * in metadata so the split survives into the trend.
 */
async function mcpProfiles(db: Pick<DbWithRaw, '$queryRaw'>): Promise<McpRow[]> {
  return db.$queryRaw<McpRow[]>(Prisma.sql`
    SELECT e.mcp_server,
           COUNT(*)::bigint                     AS calls,
           COUNT(DISTINCT e.user_id)::bigint    AS distinct_users,
           COUNT(DISTINCT e.session_id)::bigint AS session_count,
           COUNT(*) FILTER (
             WHERE e.tool_exit_status IS NOT NULL AND e.tool_exit_status <> 0
               AND e.tool_was_denied IS DISTINCT FROM true
               AND COALESCE(e.tool_output_bytes, 0) = 0
           )::bigint AS unavailable,
           COUNT(*) FILTER (
             WHERE e.tool_exit_status IS NOT NULL AND e.tool_exit_status <> 0
               AND e.tool_was_denied IS DISTINCT FROM true
               AND COALESCE(e.tool_output_bytes, 0) > 0
           )::bigint AS tool_errors
    FROM events e
    WHERE ${interactiveEvents('e')}
      AND e.ts >= NOW() - (${WINDOW_DAYS} * INTERVAL '1 day')
      AND e.event_type = 'PostToolUse'
      AND e.mcp_server IS NOT NULL
    GROUP BY e.mcp_server
  `);
}

/** Builds the score inputs for both subject kinds. Pure given the query rows. */
export function buildSubjectScoreInputs(skills: SkillRow[], mcp: McpRow[]): ScoreInput[] {
  const inputs: ScoreInput[] = [];

  for (const s of skills) {
    const calls = Number(s.downstream_calls);
    const errors = Number(s.downstream_errors);
    inputs.push({
      metadata: {
        distinctUsers: Number(s.distinct_users),
        downstreamCalls: calls,
        downstreamErrors: errors,
        invocations: Number(s.invocations),
        sessionCount: Number(s.session_count),
        windowDays: WINDOW_DAYS,
      },
      scorerName: 'skill_effectiveness',
      subjectId: skillSubjectId(s.kind === 'skill' ? 'skill' : 'slash', s.name),
      // Null below the floor — `scoreUpserts` drops the row entirely, so the
      // trend has a gap where the evidence had a gap.
      value: calls < MIN_CALLS ? null : errors / calls,
    });
  }

  for (const m of mcp) {
    const calls = Number(m.calls);
    const unavailable = Number(m.unavailable);
    const toolErrors = Number(m.tool_errors);
    inputs.push({
      metadata: {
        calls,
        distinctUsers: Number(m.distinct_users),
        sessionCount: Number(m.session_count),
        toolErrors,
        unavailable,
        windowDays: WINDOW_DAYS,
      },
      scorerName: 'mcp_effectiveness',
      subjectId: m.mcp_server,
      value: calls < MIN_CALLS ? null : (unavailable + toolErrors) / calls,
    });
  }

  return inputs;
}

/**
 * Nightly: refresh the skill and MCP-server score rows.
 *
 * Idempotent through the `scores` upsert on `(subject_type, subject_id,
 * scorer_name, scorer_version)` — a re-run on the same day rewrites the same
 * rows. Bumping `SKILL_EFFECTIVENESS_VERSION` / `MCP_EFFECTIVENESS_VERSION`
 * starts a fresh series beside the old one rather than rewriting history.
 *
 * Subject counts are bounded by how many skills and servers an org actually has
 * (tens, not millions), so this needs no keyset walk.
 */
export async function runComputeSubjectScores(db: DbWithRaw, logger?: Logger): Promise<void> {
  await withJobRun(db, 'compute-subject-scores', logger, async () => {
    const [skills, mcp] = await Promise.all([skillProfiles(db), mcpProfiles(db)]);
    const statements = scoreUpserts(buildSubjectScoreInputs(skills, mcp));
    if (statements.length > 0) {
      await db.$transaction(statements.map((sql) => db.$executeRaw(sql)));
    }
    logger?.info(
      { mcpServers: mcp.length, skills: skills.length, written: statements.length },
      'Subject scoring complete',
    );
  });
}
