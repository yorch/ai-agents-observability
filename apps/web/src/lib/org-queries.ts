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
import { labelToolRows } from './tool-usage';

export type OrgSummary = {
  activeUsers: number;
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

export async function getOrgSummary(since: Date): Promise<OrgSummary> {
  const prisma = getPrisma();

  const [teamCount, agg, [hoursRow], distinctUsers] = await Promise.all([
    prisma.team.count(),
    prisma.session.aggregate({
      _count: { sessionId: true },
      _sum: { totalCostUsd: true },
      where: {
        startedAt: { gte: since },
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
        AND u.deactivated_at IS NULL
        AND COALESCE(vp.share_metadata_with_org, true) = true
        AND s.ended_at IS NOT NULL
    `),
    prisma.session.groupBy({
      by: ['userId'],
      where: {
        startedAt: { gte: since },
        user: {
          deactivatedAt: null,
          OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
        },
      },
    }),
  ]);

  return {
    activeUsers: distinctUsers.length,
    sessionCount: agg._count.sessionId,
    teamCount,
    totalCostUsd: Number(agg._sum.totalCostUsd ?? 0),
    totalHours: Number(hoursRow?.total_seconds ?? 0) / 3600,
  };
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
  callCount: number;
  distinctUsers: number;
  kind: 'skill' | 'slash';
  name: string;
};

export type DailyToolVolumeRow = {
  callCount: number;
  day: Date;
  denyCount: number;
  distinctUsers: number;
};

export async function getToolStats(since: Date, limit = 20): Promise<ToolStatRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) return [];

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
  if (userIds.length === 0) return [];

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
  if (userIds.length === 0) return [];

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
  if (userIds.length === 0) return [];

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { call_count: bigint; distinct_users: bigint; kind: string; name: string }[]
  >(Prisma.sql`
    SELECT
      COALESCE(skill_name, slash_command)                         AS name,
      CASE WHEN skill_name IS NOT NULL THEN 'skill' ELSE 'slash' END AS kind,
      COUNT(*)                                                    AS call_count,
      COUNT(DISTINCT user_id)                                     AS distinct_users
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND (skill_name IS NOT NULL OR slash_command IS NOT NULL)
    GROUP BY skill_name, slash_command
    ORDER BY call_count DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    callCount: Number(r.call_count),
    distinctUsers: Number(r.distinct_users),
    kind: r.kind as 'skill' | 'slash',
    name: r.name,
  }));
}

export async function getDailyToolVolume(since: Date): Promise<DailyToolVolumeRow[]> {
  const userIds = await orgVisibleUserIds(since);
  if (userIds.length === 0) return [];

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
