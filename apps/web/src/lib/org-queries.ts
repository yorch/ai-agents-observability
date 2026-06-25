import { type $Enums, Prisma } from '@ai-agents-observability/db';
import {
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  ERROR_RATE_WINDOW_DAYS,
  SPEND_SPIKE_BASELINE_DAYS,
  SPEND_SPIKE_CRITICAL_SIGMA,
  SPEND_SPIKE_WARN_SIGMA,
  SPEND_SPIKE_WINDOW_DAYS,
} from '@ai-agents-observability/schemas';
import type { EffectivenessDistribution } from './effectiveness-queries';
import { getPrisma } from './prisma';
import { searchTranscriptMatches } from './search-queries';
import { type FrictionBand, frictionBandWhere } from './sessions-queries';
import { daysAgo } from './time';
import { labelToolRows } from './tool-usage';

export type OrgSummary = {
  activeUsers: number;
  cacheHitRate: number;
  sessionCount: number;
  teamCount: number;
  totalCostUsd: number;
  totalHours: number;
};

export type TeamCostRow = {
  costUsd: number;
  sessionCount: number;
  teamName: string;
  teamSlug: string;
  userCount: number;
};

export type RepoCostRow = {
  costUsd: number;
  repoName: string;
  repoOwner: string;
  sessionCount: number;
};

export type ModelCostRow = {
  costUsd: number;
  inputTokens: bigint;
  model: string;
  outputTokens: bigint;
  sessionCount: number;
};

export type DailyCostRow = {
  costUsd: number;
  day: Date;
};

export type OrgToolUsage = {
  callCount: number;
  toolName: string;
};

export type AnomalyRow = {
  kind: 'spend_spike' | 'error_spike';
  label: string;
  message: string;
  severity: 'warn' | 'critical';
};

/** Users who have opted in to org sharing and had a session in the window. */
async function orgVisibleUserIds(since: Date): Promise<string[]> {
  const prisma = getPrisma();

  // All users with sessions in window who share with org
  const rows = await prisma.user.findMany({
    select: { id: true },
    where: {
      deactivatedAt: null,
      OR: [
        { visibilityPolicy: { shareMetadataWithOrg: true } },
        { visibilityPolicy: null }, // default = share
      ],
      sessions: { some: { startedAt: { gte: since } } },
    },
  });
  return rows.map((r) => r.id);
}

async function getOrgSummaryWindow(since: Date, until?: Date): Promise<OrgSummary> {
  const prisma = getPrisma();

  const untilFilter = until ? { lt: until } : {};
  const untilClause = until ? Prisma.sql`AND s.started_at < ${until}` : Prisma.sql``;

  const [teamCount, agg, [hoursRow], distinctUsers, [cacheRow]] = await Promise.all([
    prisma.team.count(),
    prisma.session.aggregate({
      _count: { sessionId: true },
      _sum: { totalCostUsd: true },
      where: {
        startedAt: { gte: since, ...untilFilter },
        user: {
          deactivatedAt: null,
          OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
        },
      },
    }),
    prisma.$queryRaw<[{ total_seconds: number }]>(Prisma.sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM SUM(s.ended_at - s.started_at)), 0) AS total_seconds
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.started_at >= ${since}
        ${untilClause}
        AND u.deactivated_at IS NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
        AND s.ended_at IS NOT NULL
    `),
    prisma.session.groupBy({
      by: ['userId'],
      where: {
        startedAt: { gte: since, ...untilFilter },
        user: {
          deactivatedAt: null,
          OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
        },
      },
    }),
    prisma.$queryRaw<[{ cache_read: bigint; input_tokens: bigint }]>(Prisma.sql`
      SELECT
        COALESCE(SUM(s.total_cache_read), 0)    AS cache_read,
        COALESCE(SUM(s.total_input_tokens), 0)  AS input_tokens
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.started_at >= ${since}
        ${untilClause}
        AND u.deactivated_at IS NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
    `),
  ]);

  const cacheRead = Number(cacheRow?.cache_read ?? 0);
  const inputTokens = Number(cacheRow?.input_tokens ?? 0);
  const denom = inputTokens + cacheRead;
  const cacheHitRate = denom > 0 ? (cacheRead / denom) * 100 : 0;

  return {
    activeUsers: distinctUsers.length,
    cacheHitRate,
    sessionCount: agg._count.sessionId,
    teamCount,
    totalCostUsd: Number(agg._sum.totalCostUsd ?? 0),
    totalHours: Number(hoursRow?.total_seconds ?? 0) / 3600,
  };
}

export async function getOrgSummary(since: Date): Promise<OrgSummary> {
  return getOrgSummaryWindow(since);
}

export async function getCostByTeam(since: Date): Promise<TeamCostRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      cost_usd: number;
      session_count: bigint;
      team_name: string;
      team_slug: string;
      user_count: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      t.name                                         AS team_name,
      t.github_slug                                  AS team_slug,
      COUNT(DISTINCT s.user_id)                      AS user_count,
      COUNT(s.session_id)                            AS session_count,
      COALESCE(SUM(s.total_cost_usd), 0)             AS cost_usd
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
    JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    JOIN sessions s ON s.user_id = u.id AND s.started_at >= ${since}
    WHERE COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY t.id, t.name, t.github_slug
    ORDER BY cost_usd DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    costUsd: Number(r.cost_usd),
    repoName: '',
    repoOwner: '',
    sessionCount: Number(r.session_count),
    teamName: r.team_name,
    teamSlug: r.team_slug,
    userCount: Number(r.user_count),
  }));
}

export async function getCostByRepo(since: Date): Promise<RepoCostRow[]> {
  const rows = await getPrisma().$queryRaw<
    { cost_usd: number; github_name: string; github_owner: string; session_count: bigint }[]
  >(Prisma.sql`
    SELECT
      r.github_owner,
      r.github_name,
      COUNT(s.session_id)                            AS session_count,
      COALESCE(SUM(s.total_cost_usd), 0)             AS cost_usd
    FROM repos r
    JOIN sessions s ON s.repo_id = r.id AND s.started_at >= ${since}
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY r.id, r.github_owner, r.github_name
    ORDER BY cost_usd DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    costUsd: Number(r.cost_usd),
    repoName: r.github_name,
    repoOwner: r.github_owner,
    sessionCount: Number(r.session_count),
  }));
}

export async function getCostByModel(since: Date): Promise<ModelCostRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      cost_usd: number;
      input_tokens: bigint;
      model: string;
      output_tokens: bigint;
      session_count: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      COALESCE(s.primary_model, 'unknown')           AS model,
      COUNT(s.session_id)                            AS session_count,
      COALESCE(SUM(s.total_cost_usd), 0)             AS cost_usd,
      COALESCE(SUM(s.total_input_tokens), 0)         AS input_tokens,
      COALESCE(SUM(s.total_output_tokens), 0)        AS output_tokens
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${since}
      AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY COALESCE(s.primary_model, 'unknown')
    ORDER BY cost_usd DESC
  `);

  return rows.map((r) => ({
    costUsd: Number(r.cost_usd),
    inputTokens: r.input_tokens,
    model: r.model,
    outputTokens: r.output_tokens,
    sessionCount: Number(r.session_count),
  }));
}

/**
 * Org-wide friction percentiles + shape mix for the trailing window. The
 * `share_metadata_with_org` visibility filter is part of the query (not a
 * post-fetch filter), matching the other org-queries: a member who hasn't shared
 * metadata with the org never contributes to the aggregate. Null friction scores
 * are excluded (never counted as 0). Returns the shared EffectivenessDistribution
 * shape; the <5-session suppression is enforced in the rendering component.
 */
export async function getOrgEffectiveness(since: Date): Promise<EffectivenessDistribution> {
  const prisma = getPrisma();
  const [pctRows, shapeRows] = await Promise.all([
    prisma.$queryRaw<
      { count: bigint; p25: number | null; p50: number | null; p75: number | null }[]
    >(Prisma.sql`
      SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY s.friction_score) AS p25,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY s.friction_score) AS p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.friction_score) AS p75,
        COUNT(s.friction_score)                                        AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.started_at >= ${since}
        AND s.friction_score IS NOT NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
    `),
    prisma.$queryRaw<{ count: bigint; shape_label: string }[]>(Prisma.sql`
      SELECT s.shape_label, COUNT(*) AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.started_at >= ${since}
        AND s.shape_label IS NOT NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
      GROUP BY s.shape_label
    `),
  ]);

  const pct = pctRows[0];
  const scoredSessions = pct ? Number(pct.count) : 0;
  const friction =
    pct && pct.p50 !== null ? { p25: pct.p25 ?? 0, p50: pct.p50, p75: pct.p75 ?? 0 } : null;

  // Integer counts (NOT proportions) — ShapeDistributionChart renders counts and
  // derives proportions itself; feeding proportions broke its tooltip (showed 0.33).
  const shapeMix: Record<string, number> = {};
  for (const r of shapeRows) {
    shapeMix[r.shape_label] = Number(r.count);
  }

  return { friction, scoredSessions, shapeMix };
}

export async function getWeeklyCostTrend(weeks = 12): Promise<DailyCostRow[]> {
  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
  const rows = await getPrisma().$queryRaw<{ cost_usd: number; week: Date }[]>(Prisma.sql`
    SELECT
      date_trunc('week', s.started_at)              AS week,
      COALESCE(SUM(s.total_cost_usd), 0)            AS cost_usd
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${since}
      AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY date_trunc('week', s.started_at)
    ORDER BY week ASC
  `);

  return rows.map((r) => ({ costUsd: Number(r.cost_usd), day: r.week }));
}

export async function getOrgTopTools(since: Date, limit = 10): Promise<OrgToolUsage[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { agent_type: string; call_count: bigint; tool_name: string }[]
  >(Prisma.sql`
    SELECT agent_type, tool_name, COUNT(*) AS call_count
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name IS NOT NULL
    GROUP BY agent_type, tool_name
    ORDER BY call_count DESC
    LIMIT ${limit}
  `);

  return labelToolRows(rows);
}

// ── Tool / skill / MCP analytics ──────────────────────────────────────────────

export type ToolStatRow = {
  avgDurationMs: number | null;
  callCount: number;
  category: string;
  denyCount: number;
  denyRate: number;
  distinctUsers: number;
  toolName: string;
};

export type CategoryStatRow = {
  callCount: number;
  category: string;
  denyCount: number;
};

export type McpServerRow = {
  callCount: number;
  distinctUsers: number;
  mcpServer: string;
  mcpTool: string | null;
};

export type SkillRow = {
  avgSessionCostUsd: number | null;
  callCount: number;
  distinctUsers: number;
  kind: 'skill' | 'slash';
  name: string;
};

export type TeamSkillRow = {
  callCount: number;
  distinctUsers: number;
  kind: 'skill' | 'slash';
  name: string;
  teamName: string;
};

export type SkillAdoptionRow = {
  name: string;
  newUsers: number;
  recentUsers: number;
  returningUsers: number;
};

export type OrgSkillSequenceRow = {
  fromSkill: string;
  toSkill: string;
  transitionCount: number;
};

export type SkillRoiRow = {
  ciStatus: string;
  sessionCount: number;
  skillName: string;
};

export type DailyToolVolumeRow = {
  callCount: number;
  day: Date;
  denyCount: number;
  distinctUsers: number;
};

export async function getToolStats(since: Date, limit = 20): Promise<ToolStatRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    {
      agent_type: string;
      avg_duration_ms: number | null;
      call_count: bigint;
      deny_count: bigint;
      distinct_users: bigint;
      tool_category: string | null;
      tool_name: string;
    }[]
  >(Prisma.sql`
    SELECT
      agent_type,
      tool_name,
      tool_category,
      COUNT(*)                                          AS call_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)    AS deny_count,
      AVG(tool_duration_ms)                             AS avg_duration_ms,
      COUNT(DISTINCT user_id)                           AS distinct_users
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name IS NOT NULL
    GROUP BY agent_type, tool_name, tool_category
    ORDER BY call_count DESC
    LIMIT ${limit}
  `);

  const multiAgent = new Set(rows.map((r) => r.agent_type)).size > 1;
  return rows.map((r) => ({
    avgDurationMs: r.avg_duration_ms !== null ? Math.round(Number(r.avg_duration_ms)) : null,
    callCount: Number(r.call_count),
    category: r.tool_category ?? 'other',
    denyCount: Number(r.deny_count),
    denyRate: Number(r.call_count) > 0 ? Number(r.deny_count) / Number(r.call_count) : 0,
    distinctUsers: Number(r.distinct_users),
    toolName: multiAgent ? `${r.agent_type}:${r.tool_name}` : r.tool_name,
  }));
}

export async function getToolCategoryBreakdown(since: Date): Promise<CategoryStatRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { call_count: bigint; category: string; deny_count: bigint }[]
  >(Prisma.sql`
    SELECT
      COALESCE(tool_category, 'other')                  AS category,
      COUNT(*)                                          AS call_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)    AS deny_count
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
    GROUP BY COALESCE(tool_category, 'other')
    ORDER BY call_count DESC
  `);

  return rows.map((r) => ({
    callCount: Number(r.call_count),
    category: r.category,
    denyCount: Number(r.deny_count),
  }));
}

export async function getMcpServerUsage(since: Date): Promise<McpServerRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    {
      call_count: bigint;
      distinct_users: bigint;
      mcp_server: string;
      mcp_tool: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      mcp_server,
      mcp_tool,
      COUNT(*)                AS call_count,
      COUNT(DISTINCT user_id) AS distinct_users
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND mcp_server IS NOT NULL
    GROUP BY mcp_server, mcp_tool
    ORDER BY call_count DESC
    LIMIT 30
  `);

  return rows.map((r) => ({
    callCount: Number(r.call_count),
    distinctUsers: Number(r.distinct_users),
    mcpServer: r.mcp_server,
    mcpTool: r.mcp_tool,
  }));
}

export async function getSkillUsage(since: Date): Promise<SkillRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    {
      avg_session_cost_usd: string | null;
      call_count: bigint;
      distinct_users: bigint;
      kind: string;
      name: string;
    }[]
  >(Prisma.sql`
    WITH invocations AS (
      SELECT
        COALESCE(skill_name, slash_command)                            AS name,
        CASE WHEN skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END AS kind,
        session_id,
        user_id,
        COUNT(*)                                                        AS invocation_count
      FROM events
      WHERE user_id IN (${uuids})
        AND ts >= ${since}
        AND (skill_name IS NOT NULL OR slash_command IS NOT NULL)
      GROUP BY
        COALESCE(skill_name, slash_command),
        CASE WHEN skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END,
        session_id,
        user_id
    )
    SELECT
      i.name,
      i.kind,
      SUM(i.invocation_count)::bigint        AS call_count,
      COUNT(DISTINCT i.user_id)::bigint      AS distinct_users,
      AVG(s.total_cost_usd)::text            AS avg_session_cost_usd
    FROM invocations i
    LEFT JOIN sessions s ON i.session_id = s.session_id
    GROUP BY i.name, i.kind
    ORDER BY call_count DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    avgSessionCostUsd: r.avg_session_cost_usd != null ? Number(r.avg_session_cost_usd) : null,
    callCount: Number(r.call_count),
    distinctUsers: Number(r.distinct_users),
    kind: r.kind as 'skill' | 'slash',
    name: r.name,
  }));
}

// Tier 2: per-team breakdown of skill/slash usage
export async function getTeamSkillMatrix(since: Date): Promise<TeamSkillRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    {
      call_count: bigint;
      distinct_users: bigint;
      kind: string;
      name: string;
      team_name: string;
    }[]
  >(Prisma.sql`
    SELECT
      COALESCE(e.skill_name, e.slash_command)                                          AS name,
      CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END                 AS kind,
      t.name                                                                            AS team_name,
      COUNT(*)::bigint                                                                  AS call_count,
      COUNT(DISTINCT e.user_id)::bigint                                                 AS distinct_users
    FROM events e
    JOIN team_members tm ON e.user_id = tm.user_id AND tm.left_at IS NULL
    JOIN teams t ON tm.team_id = t.id
    WHERE e.user_id IN (${uuids})
      AND e.ts >= ${since}
      AND (e.skill_name IS NOT NULL OR e.slash_command IS NOT NULL)
    GROUP BY
      COALESCE(e.skill_name, e.slash_command),
      CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END,
      t.name,
      t.id
    ORDER BY call_count DESC
    LIMIT 100
  `);

  return rows.map((r) => ({
    callCount: Number(r.call_count),
    distinctUsers: Number(r.distinct_users),
    kind: r.kind as 'skill' | 'slash',
    name: r.name,
    teamName: r.team_name,
  }));
}

// Tier 2: new vs returning users per skill in the given window
export async function getSkillAdoptionFunnel(since: Date): Promise<SkillAdoptionRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    {
      name: string;
      new_users: bigint;
      recent_users: bigint;
      returning_users: bigint;
    }[]
  >(Prisma.sql`
    WITH first_use AS (
      SELECT
        user_id,
        COALESCE(skill_name, slash_command) AS name,
        MIN(ts)                              AS first_ts
      FROM events
      WHERE user_id IN (${uuids})
        AND (skill_name IS NOT NULL OR slash_command IS NOT NULL)
      GROUP BY user_id, COALESCE(skill_name, slash_command)
    ),
    recent_users AS (
      SELECT DISTINCT
        user_id,
        COALESCE(skill_name, slash_command) AS name
      FROM events
      WHERE user_id IN (${uuids})
        AND ts >= ${since}
        AND (skill_name IS NOT NULL OR slash_command IS NOT NULL)
    )
    SELECT
      ru.name,
      COUNT(DISTINCT ru.user_id)::bigint                                          AS recent_users,
      COUNT(DISTINCT ru.user_id) FILTER (WHERE fu.first_ts >= ${since})::bigint  AS new_users,
      COUNT(DISTINCT ru.user_id) FILTER (WHERE fu.first_ts < ${since})::bigint   AS returning_users
    FROM recent_users ru
    JOIN first_use fu ON ru.user_id = fu.user_id AND ru.name = fu.name
    GROUP BY ru.name
    ORDER BY recent_users DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    name: r.name,
    newUsers: Number(r.new_users),
    recentUsers: Number(r.recent_users),
    returningUsers: Number(r.returning_users),
  }));
}

// Tier 3: most common skill → skill transitions within sessions (org-wide)
export async function getOrgSkillSequences(since: Date): Promise<OrgSkillSequenceRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { from_skill: string; to_skill: string; transition_count: bigint }[]
  >(Prisma.sql`
    WITH skill_events AS (
      SELECT
        session_id,
        COALESCE(skill_name, slash_command) AS name,
        LEAD(COALESCE(skill_name, slash_command)) OVER (
          PARTITION BY session_id ORDER BY ts
        ) AS next_name
      FROM events
      WHERE user_id IN (${uuids})
        AND ts >= ${since}
        AND (skill_name IS NOT NULL OR slash_command IS NOT NULL)
    )
    SELECT
      name             AS from_skill,
      next_name        AS to_skill,
      COUNT(*)::bigint AS transition_count
    FROM skill_events
    WHERE next_name IS NOT NULL
      AND name != next_name
    GROUP BY name, next_name
    ORDER BY transition_count DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    fromSkill: r.from_skill,
    toSkill: r.to_skill,
    transitionCount: Number(r.transition_count),
  }));
}

// Tier 3: skill correlation with PR CI status (proxy for code quality impact)
export async function getSkillRoi(since: Date): Promise<SkillRoiRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { ci_status: string; session_count: bigint; skill_name: string }[]
  >(Prisma.sql`
    WITH skill_sessions AS (
      SELECT DISTINCT
        COALESCE(e.skill_name, e.slash_command) AS skill_name,
        e.session_id
      FROM events e
      WHERE e.user_id IN (${uuids})
        AND e.ts >= ${since}
        AND (e.skill_name IS NOT NULL OR e.slash_command IS NOT NULL)
    )
    SELECT
      ss.skill_name,
      s.pr_ci_status        AS ci_status,
      COUNT(DISTINCT ss.session_id)::bigint AS session_count
    FROM skill_sessions ss
    JOIN sessions s ON ss.session_id = s.session_id
    WHERE s.pr_ci_status IS NOT NULL
    GROUP BY ss.skill_name, s.pr_ci_status
    ORDER BY ss.skill_name, session_count DESC
  `);

  return rows.map((r) => ({
    ciStatus: r.ci_status,
    sessionCount: Number(r.session_count),
    skillName: r.skill_name,
  }));
}

export async function getDailyToolVolume(since: Date): Promise<DailyToolVolumeRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { call_count: bigint; day: Date; deny_count: bigint; distinct_users: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', ts)                             AS day,
      COUNT(*)                                          AS call_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)    AS deny_count,
      COUNT(DISTINCT user_id)                           AS distinct_users
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name IS NOT NULL
    GROUP BY date_trunc('day', ts)
    ORDER BY day ASC
  `);

  return rows.map((r) => ({
    callCount: Number(r.call_count),
    day: r.day,
    denyCount: Number(r.deny_count),
    distinctUsers: Number(r.distinct_users),
  }));
}

/** Anomaly detection: cost spikes (>2σ over trailing 14-day baseline) and error spikes. */
export async function getAnomalies(): Promise<AnomalyRow[]> {
  const prisma = getPrisma();
  const anomalies: AnomalyRow[] = [];

  // Cost spike detection: compare the recent window vs the prior baseline window.
  const now = new Date();
  const last7 = new Date(now.getTime() - SPEND_SPIKE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const baselineStart = new Date(
    now.getTime() - (SPEND_SPIKE_WINDOW_DAYS + SPEND_SPIKE_BASELINE_DAYS) * 24 * 60 * 60 * 1000,
  );

  const [currentPeriod, baseline] = await Promise.all([
    prisma.session.aggregate({
      _sum: { totalCostUsd: true },
      where: {
        startedAt: { gte: last7 },
        user: {
          deactivatedAt: null,
          OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
        },
      },
    }),
    prisma.$queryRaw<{ avg_cost: number; stddev_cost: number }[]>(Prisma.sql`
      SELECT
        AVG(daily_cost)    AS avg_cost,
        STDDEV(daily_cost) AS stddev_cost
      FROM (
        SELECT
          date_trunc('day', s.started_at)  AS day,
          SUM(s.total_cost_usd)            AS daily_cost
        FROM sessions s
        JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE s.started_at >= ${baselineStart}
          AND s.started_at < ${last7}
          AND COALESCE(vp.share_metadata_with_org, true) = true
        GROUP BY date_trunc('day', s.started_at)
      ) daily
    `),
  ]);

  const currentCost = Number(currentPeriod._sum.totalCostUsd ?? 0);
  const avgCost = Number(baseline[0]?.avg_cost ?? 0);
  const stddev = Number(baseline[0]?.stddev_cost ?? 0);

  if (avgCost > 0 && stddev > 0 && currentCost > avgCost + SPEND_SPIKE_WARN_SIGMA * stddev) {
    anomalies.push({
      kind: 'spend_spike',
      label: 'Spend spike',
      message: `Last ${SPEND_SPIKE_WINDOW_DAYS}-day cost ($${currentCost.toFixed(2)}) is more than ${SPEND_SPIKE_WARN_SIGMA}σ above the ${SPEND_SPIKE_BASELINE_DAYS}-day baseline ($${avgCost.toFixed(2)} ± $${stddev.toFixed(2)}/day).`,
      severity: currentCost > avgCost + SPEND_SPIKE_CRITICAL_SIGMA * stddev ? 'critical' : 'warn',
    });
  }

  // High error rate over its own (independently-tunable) window.
  const errorWindowStart = new Date(now.getTime() - ERROR_RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const errorStats = await prisma.session.aggregate({
    _sum: { toolCallCount: true, toolErrorCount: true },
    where: {
      startedAt: { gte: errorWindowStart },
      user: {
        deactivatedAt: null,
        OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
      },
    },
  });

  const totalCalls = Number(errorStats._sum.toolCallCount ?? 0);
  const totalErrors = Number(errorStats._sum.toolErrorCount ?? 0);
  if (totalCalls >= ERROR_RATE_MIN_CALLS && totalErrors / totalCalls > ERROR_RATE_WARN) {
    anomalies.push({
      kind: 'error_spike',
      label: 'High tool error rate',
      message: `${((totalErrors / totalCalls) * 100).toFixed(1)}% of tool calls failed in the last ${ERROR_RATE_WINDOW_DAYS} days (${totalErrors} errors / ${totalCalls} calls).`,
      severity: totalErrors / totalCalls > ERROR_RATE_CRITICAL ? 'critical' : 'warn',
    });
  }

  return anomalies;
}

// ── Faceted search ─────────────────────────────────────────────────────────────

export type SessionSearchFilters = {
  agentTypes?: string[] | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  frictionBand?: FrictionBand | undefined;
  model?: string | undefined;
  page?: number | undefined;
  repoId?: string | undefined;
  shapeLabels?: string[] | undefined;
  teamId?: string | undefined;
  toolName?: string | undefined;
  userId?: string | undefined;
};

export type SessionSearchResult = {
  costUsd: number;
  githubLogin: string | null;
  repoName: string | null;
  sessionId: string;
  startedAt: Date;
  status: string;
  toolCallCount: number;
};

export type SessionSearchPage = {
  page: number;
  pageSize: number;
  results: SessionSearchResult[];
  total: number;
};

const PAGE_SIZE = 50;

export async function searchSessions(
  filters: SessionSearchFilters,
  /** viewer_aggregate can only see aggregates — never individual sessions */
  canViewIndividuals: boolean,
): Promise<SessionSearchPage> {
  if (!canViewIndividuals) {
    return { page: 1, pageSize: PAGE_SIZE, results: [], total: 0 };
  }

  const prisma = getPrisma();
  const page = Math.max(1, filters.page ?? 1);

  // Collect org-visible user IDs (respect privacy policy)
  const since = filters.dateFrom ?? new Date(0);
  let scopedUserIds: string[] | undefined;

  if (filters.userId) {
    scopedUserIds = [filters.userId];
  } else if (filters.teamId) {
    const members = await prisma.teamMember.findMany({
      select: { userId: true },
      where: { leftAt: null, teamId: filters.teamId },
    });
    scopedUserIds = members.map((m) => m.userId);
  }

  const visibleIds = await orgVisibleUserIds(since);
  const finalUserIds = scopedUserIds
    ? scopedUserIds.filter((id) => visibleIds.includes(id))
    : visibleIds;

  if (finalUserIds.length === 0) {
    return { page, pageSize: PAGE_SIZE, results: [], total: 0 };
  }

  // Build Prisma where clause
  const where: Prisma.SessionWhereInput = {
    userId: { in: finalUserIds },
    ...(filters.dateFrom ? { startedAt: { gte: filters.dateFrom } } : {}),
    ...(filters.dateTo
      ? {
          startedAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            lte: filters.dateTo,
          },
        }
      : {}),
    ...(filters.model ? { primaryModel: filters.model } : {}),
    ...(filters.repoId ? { repoId: filters.repoId } : {}),
    ...(filters.shapeLabels?.length ? { shapeLabel: { in: filters.shapeLabels } } : {}),
    ...(filters.agentTypes?.length
      ? { agentType: { in: filters.agentTypes as $Enums.AgentType[] } }
      : {}),
    ...(filters.frictionBand ? { frictionScore: frictionBandWhere(filters.frictionBand) } : {}),
  };

  // Tool filter requires a sub-query on events table (not in Prisma where)
  let filteredSessionIds: string[] | undefined;
  if (filters.toolName) {
    const rows = await prisma.$queryRaw<{ session_id: string }[]>(Prisma.sql`
      SELECT DISTINCT e.session_id::text
      FROM events e
      JOIN sessions s ON s.session_id = e.session_id
      WHERE e.tool_name = ${filters.toolName}
        AND e.ts >= ${since}
        AND s.user_id = ANY(${finalUserIds}::uuid[])
      LIMIT 5000
    `);
    filteredSessionIds = rows.map((r) => r.session_id);
    if (filteredSessionIds.length === 0) {
      return { page, pageSize: PAGE_SIZE, results: [], total: 0 };
    }
    if (where.sessionId) {
      // already constrained
    } else {
      (where as Record<string, unknown>).sessionId = { in: filteredSessionIds };
    }
  }

  const [total, rows] = await Promise.all([
    prisma.session.count({ where }),
    prisma.session.findMany({
      include: {
        repo: { select: { githubName: true, githubOwner: true } },
        user: { select: { githubLogin: true } },
      },
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      where,
    }),
  ]);

  return {
    page,
    pageSize: PAGE_SIZE,
    results: rows.map((s) => ({
      costUsd: Number(s.totalCostUsd),
      githubLogin: s.user.githubLogin,
      repoName: s.repo ? `${s.repo.githubOwner}/${s.repo.githubName}` : null,
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      status: s.status,
      toolCallCount: s.toolCallCount,
    })),
    total,
  };
}

// ── Transcript FTS ─────────────────────────────────────────────────────────────

export type TranscriptSearchResult = {
  excerpt: string;
  githubLogin: string | null;
  messageIdx: number;
  role: string;
  sessionId: string;
  ts: Date | null;
};

export async function searchTranscripts(
  query: string,
  canViewIndividuals: boolean,
  limit = 20,
): Promise<TranscriptSearchResult[]> {
  // Org transcript search: only sessions from users who opted into org transcript
  // sharing. Delegates to the shared FTS core; the scope predicate stays in SQL.
  if (!canViewIndividuals || !query.trim()) {
    return [];
  }

  const matches = await searchTranscriptMatches(
    query,
    Prisma.sql`AND COALESCE(vp.share_transcripts_with_org, false) = true`,
    limit,
  );

  return matches.map((m) => ({
    excerpt: m.excerpt,
    githubLogin: m.githubLogin,
    messageIdx: m.messageIdx,
    role: m.role,
    sessionId: m.sessionId,
    ts: m.ts,
  }));
}

// ── Adoption analytics (category 5) ──────────────────────────────────────────

export type ActiveUsersTrendRow = {
  activeUsers: number;
  day: Date;
};

export async function getActiveUsersTrend(
  since: Date,
  granularity: 'day' | 'week' = 'week',
): Promise<ActiveUsersTrendRow[]> {
  const truncExpr =
    granularity === 'week'
      ? Prisma.sql`date_trunc('week', s.started_at)`
      : Prisma.sql`date_trunc('day', s.started_at)`;

  const rows = await getPrisma().$queryRaw<{ active_users: bigint; bucket: Date }[]>(Prisma.sql`
    SELECT
      ${truncExpr}              AS bucket,
      COUNT(DISTINCT s.user_id) AS active_users
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${since}
      AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY ${truncExpr}
    ORDER BY bucket ASC
  `);

  return rows.map((r) => ({ activeUsers: Number(r.active_users), day: r.bucket }));
}

export type AdoptionByTeamRow = {
  activeUsers: number;
  adoptionRate: number;
  teamName: string;
  teamSlug: string;
  totalMembers: number;
};

export async function getAdoptionByTeam(since: Date): Promise<AdoptionByTeamRow[]> {
  const rows = await getPrisma().$queryRaw<
    { active_users: bigint; team_name: string; team_slug: string; total_members: bigint }[]
  >(Prisma.sql`
    SELECT
      t.name                    AS team_name,
      t.github_slug             AS team_slug,
      COUNT(DISTINCT tm.user_id) AS total_members,
      COUNT(DISTINCT s.user_id)  AS active_users
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
    JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    LEFT JOIN sessions s
      ON s.user_id = u.id
      AND s.started_at >= ${since}
      AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY t.id, t.name, t.github_slug
    ORDER BY active_users DESC
  `);

  return rows.map((r) => {
    const total = Number(r.total_members);
    const active = Number(r.active_users);
    return {
      activeUsers: active,
      adoptionRate: total > 0 ? active / total : 0,
      teamName: r.team_name,
      teamSlug: r.team_slug,
      totalMembers: total,
    };
  });
}

export type SessionFrequencyBucket = {
  bucket: string;
  userCount: number;
};

const FREQUENCY_BUCKET_ORDER = [
  'Inactive',
  'Light (1–4)',
  'Moderate (5–19)',
  'Active (20–49)',
  'Power (50+)',
] as const;

export async function getSessionFrequencyDistribution(
  since: Date,
): Promise<SessionFrequencyBucket[]> {
  const rows = await getPrisma().$queryRaw<{ bucket: string; user_count: bigint }[]>(Prisma.sql`
    WITH per_user AS (
      SELECT
        u.id,
        COUNT(s.session_id) AS session_count
      FROM users u
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      LEFT JOIN sessions s
        ON s.user_id = u.id
        AND s.started_at >= ${since}
      WHERE u.deactivated_at IS NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
      GROUP BY u.id
    )
    SELECT
      CASE
        WHEN session_count = 0  THEN 'Inactive'
        WHEN session_count < 5  THEN 'Light (1–4)'
        WHEN session_count < 20 THEN 'Moderate (5–19)'
        WHEN session_count < 50 THEN 'Active (20–49)'
        ELSE                         'Power (50+)'
      END AS bucket,
      COUNT(*) AS user_count
    FROM per_user
    GROUP BY bucket
  `);

  const map = new Map(rows.map((r) => [r.bucket, Number(r.user_count)]));
  return FREQUENCY_BUCKET_ORDER.map((b) => ({ bucket: b, userCount: map.get(b) ?? 0 }));
}

export type CostPerDeveloperRow = {
  githubLogin: string;
  sessionCount: number;
  totalCostUsd: number;
};

/** Admin-only: per-developer cost breakdown, ordered by cost desc. */
export async function getCostPerDeveloper(since: Date, limit = 20): Promise<CostPerDeveloperRow[]> {
  const rows = await getPrisma().$queryRaw<
    { github_login: string; session_count: bigint; total_cost_usd: number }[]
  >(Prisma.sql`
    SELECT
      u.github_login,
      COUNT(s.session_id)            AS session_count,
      COALESCE(SUM(s.total_cost_usd), 0) AS total_cost_usd
    FROM users u
    JOIN sessions s ON s.user_id = u.id AND s.started_at >= ${since}
    WHERE u.deactivated_at IS NULL
    GROUP BY u.id, u.github_login
    ORDER BY total_cost_usd DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    githubLogin: r.github_login,
    sessionCount: Number(r.session_count),
    totalCostUsd: Number(r.total_cost_usd),
  }));
}

// ── PR delivery analytics (category 4) ───────────────────────────────────────

export type OrgPRDeliveryStats = {
  avgCostPerPR: number;
  medianCostPerPR: number | null;
  medianTimeToMergeHours: number | null;
  mergeRate: number;
  mergedPRs: number;
  revertRate: number;
  revertedPRs: number;
  totalPRs: number;
};

export async function getOrgPRDeliveryStats(since: Date): Promise<OrgPRDeliveryStats> {
  const rows = await getPrisma().$queryRaw<
    {
      avg_cost_per_pr: number | null;
      median_cost_per_pr: number | null;
      median_ttm_hours: number | null;
      merged_prs: bigint;
      reverted_prs: bigint;
      total_prs: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      COUNT(pr.github_id)                                                         AS total_prs,
      COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED')                     AS merged_prs,
      COUNT(pr.github_id) FILTER (WHERE pr.reverted_at IS NOT NULL)               AS reverted_prs,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (pr.merged_at - pr.opened_at)) / 3600
      ) FILTER (WHERE pr.state = 'MERGED' AND pr.opened_at IS NOT NULL AND pr.merged_at IS NOT NULL)
                                                                                  AS median_ttm_hours,
      AVG(prr.total_cost_usd)                                                     AS avg_cost_per_pr,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prr.total_cost_usd)            AS median_cost_per_pr
    FROM pull_requests pr
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE pr.opened_at >= ${since}
  `);

  const r = rows[0];
  const total = Number(r?.total_prs ?? 0);
  const merged = Number(r?.merged_prs ?? 0);
  const reverted = Number(r?.reverted_prs ?? 0);

  return {
    avgCostPerPR: Number(r?.avg_cost_per_pr ?? 0),
    medianCostPerPR: r?.median_cost_per_pr != null ? Number(r.median_cost_per_pr) : null,
    medianTimeToMergeHours: r?.median_ttm_hours != null ? Number(r.median_ttm_hours) : null,
    mergedPRs: merged,
    mergeRate: total > 0 ? merged / total : 0,
    revertedPRs: reverted,
    revertRate: merged > 0 ? reverted / merged : 0,
    totalPRs: total,
  };
}

export type PRWeeklyTrendRow = {
  avgCostUsd: number;
  mergedPRs: number;
  totalCostUsd: number;
  week: Date;
};

export async function getPRWeeklyTrend(weeks = 12): Promise<PRWeeklyTrendRow[]> {
  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
  const rows = await getPrisma().$queryRaw<
    { avg_cost_usd: number; merged_prs: bigint; total_cost_usd: number; week: Date }[]
  >(Prisma.sql`
    SELECT
      date_trunc('week', pr.merged_at)        AS week,
      COUNT(pr.github_id)                     AS merged_prs,
      COALESCE(SUM(prr.total_cost_usd), 0)    AS total_cost_usd,
      COALESCE(AVG(prr.total_cost_usd), 0)    AS avg_cost_usd
    FROM pull_requests pr
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE pr.state = 'MERGED'
      AND pr.merged_at >= ${since}
    GROUP BY date_trunc('week', pr.merged_at)
    ORDER BY week ASC
  `);

  return rows.map((r) => ({
    avgCostUsd: Number(r.avg_cost_usd),
    mergedPRs: Number(r.merged_prs),
    totalCostUsd: Number(r.total_cost_usd),
    week: r.week,
  }));
}

export type TopRepoPRRow = {
  avgCostUsd: number;
  medianTimeToMergeHours: number | null;
  mergedPRs: number;
  repoName: string;
  repoOwner: string;
};

export async function getTopReposByPR(since: Date, limit = 10): Promise<TopRepoPRRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      avg_cost_usd: number;
      median_ttm_hours: number | null;
      merged_prs: bigint;
      repo_name: string;
      repo_owner: string;
    }[]
  >(Prisma.sql`
    SELECT
      r.github_owner                                                       AS repo_owner,
      r.github_name                                                        AS repo_name,
      COUNT(pr.github_id)                                                  AS merged_prs,
      COALESCE(AVG(prr.total_cost_usd), 0)                                 AS avg_cost_usd,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (pr.merged_at - pr.opened_at)) / 3600
      ) FILTER (WHERE pr.opened_at IS NOT NULL AND pr.merged_at IS NOT NULL)
                                                                           AS median_ttm_hours
    FROM repos r
    JOIN pull_requests pr
      ON pr.repo_id = r.id
      AND pr.state = 'MERGED'
      AND pr.merged_at >= ${since}
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    GROUP BY r.id, r.github_owner, r.github_name
    ORDER BY merged_prs DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    avgCostUsd: Number(r.avg_cost_usd),
    medianTimeToMergeHours: r.median_ttm_hours != null ? Number(r.median_ttm_hours) : null,
    mergedPRs: Number(r.merged_prs),
    repoName: r.repo_name,
    repoOwner: r.repo_owner,
  }));
}

// ── Cross-team benchmarking (category 7) ─────────────────────────────────────

export type TeamBenchmarkRow = {
  avgCostPerSession: number;
  frictionP50: number | null;
  sessionCount: number;
  sessionsPerUserPerWeek: number;
  teamName: string;
  teamSlug: string;
  toolSuccessRate: number;
  userCount: number;
};

export type OrgBenchmarkMedians = {
  avgCostPerSession: number;
  frictionP50: number | null;
  sessionsPerUserPerWeek: number;
  toolSuccessRate: number;
};

export type TeamBenchmarksResult = {
  medians: OrgBenchmarkMedians;
  teams: TeamBenchmarkRow[];
};

function arrayMedian(sorted: number[]): number | null {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export async function getTeamBenchmarks(since: Date, weeks = 4): Promise<TeamBenchmarksResult> {
  const rows = await getPrisma().$queryRaw<
    {
      avg_cost_per_session: number;
      friction_p50: number | null;
      session_count: bigint;
      team_name: string;
      team_slug: string;
      total_tool_calls: bigint;
      total_tool_errors: bigint;
      user_count: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      t.name                                                               AS team_name,
      t.github_slug                                                        AS team_slug,
      COUNT(DISTINCT s.user_id)                                            AS user_count,
      COUNT(s.session_id)                                                  AS session_count,
      COALESCE(AVG(s.total_cost_usd), 0)                                   AS avg_cost_per_session,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.friction_score)
        FILTER (WHERE s.friction_score IS NOT NULL)                        AS friction_p50,
      COALESCE(SUM(s.tool_call_count), 0)                                  AS total_tool_calls,
      COALESCE(SUM(s.tool_error_count), 0)                                 AS total_tool_errors
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
    JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    JOIN sessions s ON s.user_id = u.id AND s.started_at >= ${since}
    WHERE COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY t.id, t.name, t.github_slug
    HAVING COUNT(s.session_id) >= 5
    ORDER BY session_count DESC
  `);

  const teams: TeamBenchmarkRow[] = rows.map((r) => {
    const sessions = Number(r.session_count);
    const users = Number(r.user_count);
    const calls = Number(r.total_tool_calls);
    const errors = Number(r.total_tool_errors);
    return {
      avgCostPerSession: Number(r.avg_cost_per_session),
      frictionP50: r.friction_p50 != null ? Number(r.friction_p50) : null,
      sessionCount: sessions,
      sessionsPerUserPerWeek: users > 0 && weeks > 0 ? sessions / users / weeks : 0,
      teamName: r.team_name,
      teamSlug: r.team_slug,
      toolSuccessRate: calls > 0 ? 1 - errors / calls : 1,
      userCount: users,
    };
  });

  const sorted = {
    cost: [...teams.map((t) => t.avgCostPerSession)].sort((a, b) => a - b),
    friction: [...teams.map((t) => t.frictionP50).filter((v) => v != null)].sort(
      (a, b) => (a as number) - (b as number),
    ) as number[],
    spw: [...teams.map((t) => t.sessionsPerUserPerWeek)].sort((a, b) => a - b),
    success: [...teams.map((t) => t.toolSuccessRate)].sort((a, b) => a - b),
  };

  return {
    medians: {
      avgCostPerSession: arrayMedian(sorted.cost) ?? 0,
      frictionP50: arrayMedian(sorted.friction),
      sessionsPerUserPerWeek: arrayMedian(sorted.spw) ?? 0,
      toolSuccessRate: arrayMedian(sorted.success) ?? 1,
    },
    teams,
  };
}

// ── Feature B + E: org delta-aware summary ─────────────────────────────────────

export async function getOrgSummaryWithDelta(range: number): Promise<{
  current: OrgSummary;
  deltas: {
    activeUsers: number | null;
    cacheHitRate: number | null;
    sessionCount: number | null;
    totalCostUsd: number | null;
  };
}> {
  const currentStart = daysAgo(range);
  const priorStart = daysAgo(2 * range);
  const priorEnd = currentStart;

  const [current, prior] = await Promise.all([
    getOrgSummaryWindow(currentStart),
    getOrgSummaryWindow(priorStart, priorEnd),
  ]);

  const delta = (cur: number, prev: number): number | null =>
    prev > 0 ? (cur - prev) / prev : null;

  return {
    current,
    deltas: {
      activeUsers: delta(current.activeUsers, prior.activeUsers),
      cacheHitRate: delta(current.cacheHitRate, prior.cacheHitRate),
      sessionCount: delta(current.sessionCount, prior.sessionCount),
      totalCostUsd: delta(current.totalCostUsd, prior.totalCostUsd),
    },
  };
}

// ── Feature D: adoption funnel ─────────────────────────────────────────────────

export type OrgAdoptionFunnel = {
  active30d: number;
  active30dDelta: number | null;
  active7d: number;
  everUsers: number;
  newThisMonth: number;
};

export async function getOrgAdoptionFunnel(range: number): Promise<OrgAdoptionFunnel> {
  const prisma = getPrisma();

  const currentWindowStart = daysAgo(range);
  const thirtyDaysAgo = daysAgo(30);
  const sevenDaysAgo = daysAgo(7);
  const sixtyDaysAgo = daysAgo(60);

  // Visibility predicate fragment (reused across queries)
  const [everRow, active30dRow, active7dRow, newThisMonthRow, priorActive30dRow] =
    await Promise.all([
      // everUsers: org-visible non-deactivated users with at least one session ever
      prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT u.id) AS cnt
        FROM users u
        JOIN sessions s ON s.user_id = u.id
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE u.deactivated_at IS NULL
          AND COALESCE(vp.share_metadata_with_org, true) = true
      `),
      // active30d: distinct org-visible users with a session in the last 30 days
      prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT u.id) AS cnt
        FROM users u
        JOIN sessions s ON s.user_id = u.id
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE u.deactivated_at IS NULL
          AND COALESCE(vp.share_metadata_with_org, true) = true
          AND s.started_at >= ${thirtyDaysAgo}
      `),
      // active7d: distinct org-visible users with a session in the last 7 days
      prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT u.id) AS cnt
        FROM users u
        JOIN sessions s ON s.user_id = u.id
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE u.deactivated_at IS NULL
          AND COALESCE(vp.share_metadata_with_org, true) = true
          AND s.started_at >= ${sevenDaysAgo}
      `),
      // newThisMonth: users whose FIRST-ever session falls within [daysAgo(range), now)
      prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(*) AS cnt
        FROM (
          SELECT u.id
          FROM users u
          JOIN sessions s ON s.user_id = u.id
          LEFT JOIN visibility_policies vp ON vp.user_id = u.id
          WHERE u.deactivated_at IS NULL
            AND COALESCE(vp.share_metadata_with_org, true) = true
          GROUP BY u.id
          HAVING MIN(s.started_at) >= ${currentWindowStart}
        ) t
      `),
      // prior active30d: sessions in [daysAgo(60), daysAgo(30))
      prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT u.id) AS cnt
        FROM users u
        JOIN sessions s ON s.user_id = u.id
        LEFT JOIN visibility_policies vp ON vp.user_id = u.id
        WHERE u.deactivated_at IS NULL
          AND COALESCE(vp.share_metadata_with_org, true) = true
          AND s.started_at >= ${sixtyDaysAgo}
          AND s.started_at < ${thirtyDaysAgo}
      `),
    ]);

  const active30d = Number(active30dRow[0]?.cnt ?? 0);
  const priorActive30d = Number(priorActive30dRow[0]?.cnt ?? 0);
  const active30dDelta = priorActive30d > 0 ? (active30d - priorActive30d) / priorActive30d : null;

  return {
    active7d: Number(active7dRow[0]?.cnt ?? 0),
    active30d,
    active30dDelta,
    everUsers: Number(everRow[0]?.cnt ?? 0),
    newThisMonth: Number(newThisMonthRow[0]?.cnt ?? 0),
  };
}

// ── Feature F: team model governance ──────────────────────────────────────────

// ── Skill analytics — daily volume & per-skill detail ──────────────────────────

export type DailySkillVolumeRow = {
  day: Date;
  distinctUsers: number;
  invocationCount: number;
};

export type SkillTopUserRow = {
  displayName: string | null;
  githubLogin: string;
  invocationCount: number;
  sessionCount: number;
};

export type SkillCostComparisonRow = {
  avgCostUsd: number;
  hasSkill: boolean;
  sessionCount: number;
};

export async function getDailySkillVolume(since: Date): Promise<DailySkillVolumeRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }
  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { day: Date; distinct_users: bigint; invocation_count: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', ts)          AS day,
      COUNT(*)::bigint               AS invocation_count,
      COUNT(DISTINCT user_id)::bigint AS distinct_users
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND (skill_name IS NOT NULL OR slash_command IS NOT NULL)
    GROUP BY date_trunc('day', ts)
    ORDER BY day ASC
  `);
  return rows.map((r) => ({
    day: r.day,
    distinctUsers: Number(r.distinct_users),
    invocationCount: Number(r.invocation_count),
  }));
}

export async function getOrgSkillDailyTrend(
  name: string,
  kind: 'skill' | 'slash',
  since: Date,
): Promise<DailySkillVolumeRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }
  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { day: Date; distinct_users: bigint; invocation_count: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', ts)          AS day,
      COUNT(*)::bigint               AS invocation_count,
      COUNT(DISTINCT user_id)::bigint AS distinct_users
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND COALESCE(skill_name, slash_command) = ${name}
      AND CASE WHEN skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END = ${kind}
    GROUP BY date_trunc('day', ts)
    ORDER BY day ASC
  `);
  return rows.map((r) => ({
    day: r.day,
    distinctUsers: Number(r.distinct_users),
    invocationCount: Number(r.invocation_count),
  }));
}

export async function getOrgSkillTopUsers(
  name: string,
  kind: 'skill' | 'slash',
  since: Date,
): Promise<SkillTopUserRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }
  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    {
      display_name: string | null;
      github_login: string;
      invocation_count: bigint;
      session_count: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      u.github_login,
      u.display_name,
      COUNT(*)::bigint                     AS invocation_count,
      COUNT(DISTINCT e.session_id)::bigint AS session_count
    FROM events e
    JOIN users u ON e.user_id = u.id
    WHERE e.user_id IN (${uuids})
      AND e.ts >= ${since}
      AND COALESCE(e.skill_name, e.slash_command) = ${name}
      AND CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END = ${kind}
    GROUP BY u.id, u.github_login, u.display_name
    ORDER BY invocation_count DESC
    LIMIT 20
  `);
  return rows.map((r) => ({
    displayName: r.display_name,
    githubLogin: r.github_login,
    invocationCount: Number(r.invocation_count),
    sessionCount: Number(r.session_count),
  }));
}

export async function getOrgSkillCostComparison(
  name: string,
  kind: 'skill' | 'slash',
  since: Date,
): Promise<SkillCostComparisonRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) {
    return [];
  }
  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { avg_cost_usd: string | null; has_skill: boolean; session_count: bigint }[]
  >(Prisma.sql`
    SELECT
      has_skill,
      AVG(total_cost_usd)::text  AS avg_cost_usd,
      COUNT(*)::bigint           AS session_count
    FROM (
      SELECT
        s.session_id,
        s.total_cost_usd,
        EXISTS(
          SELECT 1 FROM events e
          WHERE e.session_id = s.session_id
            AND COALESCE(e.skill_name, e.slash_command) = ${name}
            AND CASE WHEN e.skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END = ${kind}
        ) AS has_skill
      FROM sessions s
      WHERE s.user_id IN (${uuids})
        AND s.started_at >= ${since}
        AND s.total_cost_usd IS NOT NULL
    ) sub
    GROUP BY has_skill
  `);
  return rows.map((r) => ({
    avgCostUsd: r.avg_cost_usd != null ? Number(r.avg_cost_usd) : 0,
    hasSkill: r.has_skill,
    sessionCount: Number(r.session_count),
  }));
}

export type TeamModelGovernanceRow = {
  modelCostPct: number;
  teamName: string;
  teamSlug: string;
  topModel: string;
  topModelCostUsd: number;
  totalCostUsd: number;
};

export async function getTeamModelGovernance(
  since: Date,
  limit = 10,
): Promise<TeamModelGovernanceRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      team_name: string;
      team_slug: string;
      top_model: string;
      top_model_cost: string;
      total_cost: string;
    }[]
  >(Prisma.sql`
    WITH team_model AS (
      SELECT
        t.id                                          AS team_id,
        t.name                                        AS team_name,
        t.github_slug                                 AS team_slug,
        COALESCE(s.primary_model, 'unknown')          AS model,
        SUM(s.total_cost_usd)                         AS model_cost
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
      JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      JOIN sessions s ON s.user_id = u.id AND s.started_at >= ${since}
      WHERE COALESCE(vp.share_metadata_with_org, true) = true
      GROUP BY t.id, t.name, t.github_slug, COALESCE(s.primary_model, 'unknown')
    ),
    team_total AS (
      SELECT
        team_id,
        team_name,
        team_slug,
        SUM(model_cost) AS total_cost
      FROM team_model
      GROUP BY team_id, team_name, team_slug
    ),
    top_model AS (
      SELECT DISTINCT ON (team_id)
        team_id,
        model,
        model_cost
      FROM team_model
      ORDER BY team_id, model_cost DESC
    )
    SELECT
      tt.team_name,
      tt.team_slug,
      tm.model          AS top_model,
      tm.model_cost     AS top_model_cost,
      tt.total_cost
    FROM team_total tt
    JOIN top_model tm ON tm.team_id = tt.team_id
    ORDER BY tt.total_cost DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => {
    const totalCostUsd = Number(r.total_cost ?? 0);
    const topModelCostUsd = Number(r.top_model_cost ?? 0);
    return {
      modelCostPct: totalCostUsd > 0 ? (topModelCostUsd / totalCostUsd) * 100 : 0,
      teamName: r.team_name,
      teamSlug: r.team_slug,
      topModel: r.top_model,
      topModelCostUsd,
      totalCostUsd,
    };
  });
}
