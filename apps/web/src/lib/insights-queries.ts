import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type SessionSummaryRow = {
  avgCostUsd: number;
  sessionCount: number;
  totalCostUsd: number;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
};

type SessionSummaryRaw = {
  avg_cost_usd: string | null;
  session_count: bigint;
  total_cost_usd: string;
  total_input_tokens: bigint;
  total_output_tokens: bigint;
};

export async function getSessionSummary(userId: string, since: Date): Promise<SessionSummaryRow> {
  const rows = await getPrisma().$queryRaw<SessionSummaryRaw[]>(Prisma.sql`
    SELECT
      COUNT(*)                                                  AS session_count,
      COALESCE(SUM(total_cost_usd), 0)::text                   AS total_cost_usd,
      AVG(NULLIF(total_cost_usd, 0))::text                     AS avg_cost_usd,
      COALESCE(SUM(total_input_tokens), 0)::bigint             AS total_input_tokens,
      COALESCE(SUM(total_output_tokens), 0)::bigint            AS total_output_tokens
    FROM interactive_sessions
    WHERE user_id    = ${userId}::uuid
      AND started_at >= ${since}
  `);
  const r = rows[0] ?? {
    avg_cost_usd: null,
    session_count: 0n,
    total_cost_usd: '0',
    total_input_tokens: 0n,
    total_output_tokens: 0n,
  };
  return {
    avgCostUsd: r.avg_cost_usd != null ? Number(r.avg_cost_usd) : 0,
    sessionCount: Number(r.session_count),
    totalCostUsd: Number(r.total_cost_usd),
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
  };
}

// Context-window pressure & session-continuity signals (Tier 1). All captured on
// the sessions row (compaction_count, clear_count, is_resume) but previously
// rendered nowhere. High compaction/clear counts flag sessions fighting the
// context limit; the resume ratio is a per-user continuity signal (DESIGN_DOC
// §10.2 "resume vs fresh-start ratio").
export type ContinuitySummaryRow = {
  resumedSessions: number;
  sessionCount: number;
  sessionsWithReset: number;
  totalClears: number;
  totalCompactions: number;
};

type ContinuitySummaryRaw = {
  resumed_sessions: bigint;
  session_count: bigint;
  sessions_with_reset: bigint;
  total_clears: bigint;
  total_compactions: bigint;
};

export async function getContinuitySummary(
  userId: string,
  since: Date,
): Promise<ContinuitySummaryRow> {
  const rows = await getPrisma().$queryRaw<ContinuitySummaryRaw[]>(Prisma.sql`
    SELECT
      COUNT(*)                                                          AS session_count,
      COUNT(*) FILTER (WHERE is_resume)                                 AS resumed_sessions,
      COUNT(*) FILTER (WHERE compaction_count > 0 OR clear_count > 0)   AS sessions_with_reset,
      COALESCE(SUM(compaction_count), 0)::bigint                        AS total_compactions,
      COALESCE(SUM(clear_count), 0)::bigint                             AS total_clears
    FROM interactive_sessions
    WHERE user_id    = ${userId}::uuid
      AND started_at >= ${since}
  `);
  const r = rows[0] ?? {
    resumed_sessions: 0n,
    session_count: 0n,
    sessions_with_reset: 0n,
    total_clears: 0n,
    total_compactions: 0n,
  };
  return {
    resumedSessions: Number(r.resumed_sessions),
    sessionCount: Number(r.session_count),
    sessionsWithReset: Number(r.sessions_with_reset),
    totalClears: Number(r.total_clears),
    totalCompactions: Number(r.total_compactions),
  };
}

// Per-kind breakdown of Notification events (Tier 1). The sessions row only keeps
// an aggregate notification_count; the normalized `notification_kind` on the
// events firehose (permission / idle / elicitation / auth / other) is the finer
// Human-in-the-Loop signal that was captured but never surfaced.
export type NotificationKindRow = {
  count: number;
  kind: string;
};

export async function getNotificationKinds(
  userId: string,
  since: Date,
): Promise<NotificationKindRow[]> {
  const rows = await getPrisma().$queryRaw<{ count: bigint; kind: string }[]>(Prisma.sql`
    SELECT notification_kind AS kind, COUNT(*) AS count
    FROM interactive_events
    WHERE user_id = ${userId}::uuid
      AND ts     >= ${since}
      AND notification_kind IS NOT NULL
    GROUP BY notification_kind
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ count: Number(r.count), kind: r.kind }));
}

export type McpUsageRow = {
  avgDurationMs: number | null;
  callCount: number;
  errorCount: number;
  mcpServer: string;
  mcpTool: string | null;
};

export type SkillUsageRow = {
  /**
   * P14-004. Two lenses on the same dollars, never a total: the issuing turn's
   * share, and the input-side inflation this skill's tool output caused on the
   * following turn. NULL means the events carried no turn linkage — not $0.00.
   */
  attributedCostUsd: number | null;
  /** The pre-P14-004 proxy, kept beside the real number. See org-queries.ts. */
  avgSessionCostUsd: number | null;
  downstreamCostUsd: number | null;
  sessionCount: number;
  skillName: string;
  skillPath: string | null;
  useCount: number;
};

export type SkillOutcomeRow = {
  sessionCount: number;
  skillName: string;
  status: string;
};

export type SkillTrendRow = {
  day: Date;
  skillName: string;
  useCount: number;
};

export type SkillSubagentRow = {
  avgSubagents: number;
  maxSubagents: number;
  sessionCount: number;
  skillName: string;
};

export type SkillSequenceRow = {
  fromSkill: string;
  toSkill: string;
  transitionCount: number;
};

export type SlashCommandRow = {
  command: string;
  useCount: number;
};

export type SubagentUsageRow = {
  /** P14-004 — see `SkillUsageRow`. Not additive with `downstreamCostUsd`. */
  attributedCostUsd: number | null;
  downstreamCostUsd: number | null;
  subagentType: string;
  useCount: number;
};

export type ToolPerfRow = {
  /** P14-004 — see `SkillUsageRow`. Not additive with `downstreamCostUsd`. */
  attributedCostUsd: number | null;
  avgDurationMs: number | null;
  avgInputBytes: number | null;
  avgOutputBytes: number | null;
  callCount: number;
  deniedCount: number;
  downstreamCostUsd: number | null;
  errorCount: number;
  p95DurationMs: number | null;
  toolCategory: string | null;
  toolName: string;
};

export type UserModelRoutingRow = {
  // Routing policy is per-agent (see packages/schemas/src/model-policy.ts), so
  // the agent has to travel with the row.
  agentType: string;
  callCount: number;
  model: string;
  toolCategory: string;
  totalCostUsd: number;
};

export type UserCacheSummaryRow = {
  sessionCount: number;
  totalCacheReadTokens: bigint;
  totalInputTokens: bigint;
};

type McpRawRow = {
  avg_duration_ms: string | null;
  call_count: bigint;
  error_count: bigint;
  mcp_server: string;
  mcp_tool: string | null;
};

type SkillUsageRawRow = {
  attributed_cost_usd: string | null;
  avg_session_cost_usd: string | null;
  downstream_cost_usd: string | null;
  session_count: bigint;
  skill_name: string;
  skill_path: string | null;
  use_count: bigint;
};

type SkillOutcomeRawRow = { session_count: bigint; skill_name: string; status: string };
type SkillTrendRawRow = { day: Date; skill_name: string; use_count: bigint };
type SkillSubagentRawRow = {
  avg_subagents: string;
  max_subagents: bigint;
  session_count: bigint;
  skill_name: string;
};
type SkillSequenceRawRow = {
  from_skill: string;
  to_skill: string;
  transition_count: bigint;
};

type SlashCommandRawRow = { slash_command: string; use_count: bigint };
type SubagentRawRow = {
  attributed_cost_usd: string | null;
  downstream_cost_usd: string | null;
  subagent_type: string;
  use_count: bigint;
};

type ToolPerfRawRow = {
  attributed_cost_usd: string | null;
  avg_duration_ms: string | null;
  avg_input_bytes: string | null;
  avg_output_bytes: string | null;
  call_count: bigint;
  denied_count: bigint;
  downstream_cost_usd: string | null;
  error_count: bigint;
  p95_duration_ms: string | null;
  tool_category: string | null;
  tool_name: string;
};

type UserModelRoutingRawRow = {
  agent_type: string;
  call_count: bigint;
  model: string;
  tool_category: string;
  total_cost_usd: string;
};

type UserCacheSummaryRawRow = {
  session_count: bigint;
  total_cache_read: bigint;
  total_input_tokens: bigint;
};

export async function getMcpUsage(userId: string, since: Date): Promise<McpUsageRow[]> {
  const rows = await getPrisma().$queryRaw<McpRawRow[]>(Prisma.sql`
    SELECT
      mcp_server,
      mcp_tool,
      COUNT(*)                                                                AS call_count,
      COUNT(*) FILTER (WHERE tool_exit_status IS NOT NULL
                         AND tool_exit_status != 0)                          AS error_count,
      AVG(tool_duration_ms)::text                                            AS avg_duration_ms
    FROM interactive_events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND mcp_server IS NOT NULL
    GROUP BY mcp_server, mcp_tool
    ORDER BY call_count DESC
    LIMIT 100
  `);
  return rows.map((r: McpRawRow) => ({
    avgDurationMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
    callCount: Number(r.call_count),
    errorCount: Number(r.error_count),
    mcpServer: r.mcp_server,
    mcpTool: r.mcp_tool,
  }));
}

// Tier 1: use count + session cost (avg cost of sessions that used this skill)
export async function getSkillUsage(userId: string, since: Date): Promise<SkillUsageRow[]> {
  const rows = await getPrisma().$queryRaw<SkillUsageRawRow[]>(Prisma.sql`
    WITH invocations AS (
      SELECT
        skill_name, skill_path, session_id,
        COUNT(*) AS invocation_count,
        -- P14-004: summed per (skill, session) here and rolled up below, so the
        -- attribution follows exactly the rows this CTE counts.
        SUM(attributed_cost_usd) AS attributed_cost_usd,
        SUM(downstream_cost_usd) AS downstream_cost_usd
      FROM interactive_events
      WHERE user_id = ${userId}::uuid
        AND ts       >= ${since}
        AND skill_name IS NOT NULL
      GROUP BY skill_name, skill_path, session_id
    )
    SELECT
      i.skill_name,
      i.skill_path,
      SUM(i.invocation_count)::bigint           AS use_count,
      COUNT(DISTINCT i.session_id)::bigint       AS session_count,
      SUM(i.attributed_cost_usd)::text           AS attributed_cost_usd,
      SUM(i.downstream_cost_usd)::text           AS downstream_cost_usd,
      -- The pre-P14-004 proxy, kept beside the real numbers rather than
      -- replaced — see getSkillUsage in org-queries.ts.
      AVG(s.total_cost_usd)::text                AS avg_session_cost_usd
    -- run-kind-exempt: the population is fixed by the guarded invocations CTE
    -- above, so every session reachable here is already INTERACTIVE. Repeating the
    -- filter on this LEFT JOIN would not exclude anything — it would only turn a
    -- row NULL (and so silently drop it from the cost average) if sessions.run_kind
    -- ever disagreed with events.run_kind.
    FROM invocations i
    LEFT JOIN interactive_sessions s ON i.session_id = s.session_id
    GROUP BY i.skill_name, i.skill_path
    ORDER BY use_count DESC
    LIMIT 50
  `);
  return rows.map((r) => ({
    attributedCostUsd: r.attributed_cost_usd != null ? Number(r.attributed_cost_usd) : null,
    avgSessionCostUsd: r.avg_session_cost_usd != null ? Number(r.avg_session_cost_usd) : null,
    downstreamCostUsd: r.downstream_cost_usd != null ? Number(r.downstream_cost_usd) : null,
    sessionCount: Number(r.session_count),
    skillName: r.skill_name,
    skillPath: r.skill_path,
    useCount: Number(r.use_count),
  }));
}

// Tier 1: session outcome distribution per skill (COMPLETED / ABANDONED / ERROR)
export async function getSkillOutcomes(userId: string, since: Date): Promise<SkillOutcomeRow[]> {
  const rows = await getPrisma().$queryRaw<SkillOutcomeRawRow[]>(Prisma.sql`
    SELECT
      e.skill_name,
      s.status,
      COUNT(DISTINCT e.session_id)::bigint AS session_count
    -- INNER, not LEFT: a session that is filtered out must disappear from the
    -- distribution entirely. Under a LEFT JOIN the guard only nulls s.status, and
    -- SkillOutcomeRawRow types that column as a non-nullable string, so the null
    -- would flow into the UI typed as a status and render as an extra outcome band.
    FROM interactive_events e
    JOIN interactive_sessions s ON e.session_id = s.session_id
    
      AND e.user_id = ${userId}::uuid
      AND e.ts       >= ${since}
      AND e.skill_name IS NOT NULL
    GROUP BY e.skill_name, s.status
    ORDER BY e.skill_name, session_count DESC
  `);
  return rows.map((r) => ({
    sessionCount: Number(r.session_count),
    skillName: r.skill_name,
    status: r.status,
  }));
}

// Tier 1: daily invocation trend per skill
export async function getSkillTrend(userId: string, since: Date): Promise<SkillTrendRow[]> {
  const rows = await getPrisma().$queryRaw<SkillTrendRawRow[]>(Prisma.sql`
    SELECT
      date_trunc('day', ts)   AS day,
      skill_name,
      COUNT(*)::bigint         AS use_count
    FROM interactive_events
    WHERE user_id    = ${userId}::uuid
      AND ts         >= ${since}
      AND skill_name IS NOT NULL
    GROUP BY date_trunc('day', ts), skill_name
    ORDER BY day ASC
  `);
  return rows.map((r) => ({
    day: r.day,
    skillName: r.skill_name,
    useCount: Number(r.use_count),
  }));
}

// Tier 2: avg subagents spawned in sessions that used each skill
export async function getSkillSubagents(userId: string, since: Date): Promise<SkillSubagentRow[]> {
  const rows = await getPrisma().$queryRaw<SkillSubagentRawRow[]>(Prisma.sql`
    WITH sessions_with_skill AS (
      SELECT DISTINCT skill_name, session_id
      FROM interactive_events
      WHERE user_id    = ${userId}::uuid
        AND ts         >= ${since}
        AND skill_name IS NOT NULL
    ),
    subagent_counts AS (
      SELECT session_id, COUNT(*) AS subagent_count
      FROM interactive_events
      WHERE user_id    = ${userId}::uuid
        AND ts         >= ${since}
        AND event_type = 'SubagentStop'
      GROUP BY session_id
    )
    SELECT
      sws.skill_name,
      COUNT(DISTINCT sws.session_id)::bigint           AS session_count,
      AVG(COALESCE(sc.subagent_count, 0))::text        AS avg_subagents,
      MAX(COALESCE(sc.subagent_count, 0))::bigint      AS max_subagents
    FROM sessions_with_skill sws
    LEFT JOIN subagent_counts sc ON sws.session_id = sc.session_id
    GROUP BY sws.skill_name
    ORDER BY avg_subagents DESC
  `);
  return rows.map((r) => ({
    avgSubagents: r.avg_subagents != null ? Number(r.avg_subagents) : 0,
    maxSubagents: Number(r.max_subagents),
    sessionCount: Number(r.session_count),
    skillName: r.skill_name,
  }));
}

// Tier 3: most common skill → skill transitions within sessions
export async function getSkillSequences(userId: string, since: Date): Promise<SkillSequenceRow[]> {
  const rows = await getPrisma().$queryRaw<SkillSequenceRawRow[]>(Prisma.sql`
    WITH skill_events AS (
      SELECT
        session_id,
        skill_name,
        LEAD(skill_name) OVER (PARTITION BY session_id ORDER BY ts) AS next_skill
      FROM interactive_events
      WHERE user_id    = ${userId}::uuid
        AND ts         >= ${since}
        AND skill_name IS NOT NULL
    )
    SELECT
      skill_name           AS from_skill,
      next_skill           AS to_skill,
      COUNT(*)::bigint     AS transition_count
    FROM skill_events
    WHERE next_skill IS NOT NULL
      AND skill_name != next_skill
    GROUP BY skill_name, next_skill
    ORDER BY transition_count DESC
    LIMIT 20
  `);
  return rows.map((r) => ({
    fromSkill: r.from_skill,
    toSkill: r.to_skill,
    transitionCount: Number(r.transition_count),
  }));
}

export async function getSlashCommands(userId: string, since: Date): Promise<SlashCommandRow[]> {
  const rows = await getPrisma().$queryRaw<SlashCommandRawRow[]>(Prisma.sql`
    SELECT slash_command, COUNT(*) AS use_count
    FROM interactive_events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND slash_command IS NOT NULL
    GROUP BY slash_command
    ORDER BY use_count DESC
    LIMIT 50
  `);
  return rows.map((r: SlashCommandRawRow) => ({
    command: r.slash_command,
    useCount: Number(r.use_count),
  }));
}

export async function getSubagentUsage(userId: string, since: Date): Promise<SubagentUsageRow[]> {
  const rows = await getPrisma().$queryRaw<SubagentRawRow[]>(Prisma.sql`
    SELECT
      subagent_type,
      COUNT(*) AS use_count,
      -- P14-004. Two readings of the same dollars, never added together: the
      -- issuing turn's share of this spawn, and the input-side inflation the
      -- sub-agent's result caused on the turn that read it.
      SUM(attributed_cost_usd)::text AS attributed_cost_usd,
      SUM(downstream_cost_usd)::text AS downstream_cost_usd
    FROM interactive_events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND subagent_type IS NOT NULL
    GROUP BY subagent_type
    ORDER BY use_count DESC
  `);
  return rows.map((r: SubagentRawRow) => ({
    attributedCostUsd: r.attributed_cost_usd != null ? Number(r.attributed_cost_usd) : null,
    downstreamCostUsd: r.downstream_cost_usd != null ? Number(r.downstream_cost_usd) : null,
    subagentType: r.subagent_type,
    useCount: Number(r.use_count),
  }));
}

export async function getToolPerf(userId: string, since: Date): Promise<ToolPerfRow[]> {
  const rows = await getPrisma().$queryRaw<ToolPerfRawRow[]>(Prisma.sql`
    SELECT
      tool_name,
      tool_category,
      COUNT(*)                                                                AS call_count,
      COUNT(*) FILTER (WHERE tool_exit_status IS NOT NULL
                         AND tool_exit_status != 0)                          AS error_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)                        AS denied_count,
      AVG(tool_duration_ms)::text                                            AS avg_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tool_duration_ms)::text  AS p95_duration_ms,
      AVG(tool_input_bytes)::text                                           AS avg_input_bytes,
      AVG(tool_output_bytes)::text                                          AS avg_output_bytes,
      -- P14-004. Two readings of the same dollars — never added together.
      SUM(attributed_cost_usd)::text                                        AS attributed_cost_usd,
      SUM(downstream_cost_usd)::text                                        AS downstream_cost_usd
    FROM interactive_events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name  IS NOT NULL
    GROUP BY tool_name, tool_category
    ORDER BY call_count DESC
    LIMIT 25
  `);
  return rows.map((r: ToolPerfRawRow) => ({
    attributedCostUsd: r.attributed_cost_usd != null ? Number(r.attributed_cost_usd) : null,
    avgDurationMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
    avgInputBytes: r.avg_input_bytes != null ? Math.round(Number(r.avg_input_bytes)) : null,
    avgOutputBytes: r.avg_output_bytes != null ? Math.round(Number(r.avg_output_bytes)) : null,
    callCount: Number(r.call_count),
    deniedCount: Number(r.denied_count),
    downstreamCostUsd: r.downstream_cost_usd != null ? Number(r.downstream_cost_usd) : null,
    errorCount: Number(r.error_count),
    p95DurationMs: r.p95_duration_ms != null ? Math.round(Number(r.p95_duration_ms)) : null,
    toolCategory: r.tool_category,
    toolName: r.tool_name,
  }));
}

export async function getUserModelRouting(
  userId: string,
  since: Date,
): Promise<UserModelRoutingRow[]> {
  const rows = await getPrisma().$queryRaw<UserModelRoutingRawRow[]>(Prisma.sql`
    SELECT
      agent_type,
      model,
      tool_category,
      COUNT(*)                    AS call_count,
      COALESCE(SUM(cost_usd), 0)  AS total_cost_usd
    FROM interactive_events
    WHERE user_id = ${userId}::uuid
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND model IS NOT NULL
      AND tool_category IS NOT NULL
    GROUP BY agent_type, model, tool_category
    ORDER BY total_cost_usd DESC
    LIMIT 200
  `);
  return rows.map((r) => ({
    agentType: r.agent_type,
    callCount: Number(r.call_count),
    model: r.model,
    toolCategory: r.tool_category,
    totalCostUsd: Number(r.total_cost_usd),
  }));
}

export async function getUserCacheSummary(
  userId: string,
  since: Date,
): Promise<UserCacheSummaryRow> {
  const rows = await getPrisma().$queryRaw<UserCacheSummaryRawRow[]>(Prisma.sql`
    SELECT
      COUNT(*)                              AS session_count,
      COALESCE(SUM(total_input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(total_cache_read), 0)    AS total_cache_read
    FROM interactive_sessions
    WHERE user_id = ${userId}::uuid
      AND started_at >= ${since}
  `);
  const r = rows[0] ?? { session_count: 0n, total_cache_read: 0n, total_input_tokens: 0n };
  return {
    sessionCount: Number(r.session_count),
    totalCacheReadTokens: r.total_cache_read,
    totalInputTokens: r.total_input_tokens,
  };
}
