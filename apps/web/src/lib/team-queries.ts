import { Prisma } from '@ai-agents-observability/db';

import type {
  CategoryStatRow,
  DailySkillVolumeRow,
  DailyToolVolumeRow,
  SkillAdoptionRow,
  SkillCostComparisonRow,
  SkillRow,
  SkillTopUserRow,
  ToolStatRow,
} from './org-queries';
import { getPrisma } from './prisma';
import type { SessionRow } from './sessions-queries';
import { daysAgo } from './time';
import { labelToolRows } from './tool-usage';

const toUuidList = (ids: string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

export type TeamSummary = {
  activeMembers: number;
  cacheHitRate: number;
  sessionCount: number;
  totalCostUsd: number;
  totalHours: number;
};

export type TeamToolUsage = {
  callCount: number;
  toolName: string;
};

export type TeamModelMix = {
  costUsd: number;
  model: string;
  sessionCount: number;
  turns: number;
};

export type RosterMember = {
  canViewStats: boolean;
  displayName: string | null;
  githubLogin: string | null;
  role: string;
  sessionCount: number | null;
  totalCostUsd: number | null;
  userId: string;
};

async function activeTeamMemberIds(teamId: string): Promise<string[]> {
  const rows = await getPrisma().teamMember.findMany({
    select: { userId: true },
    where: { leftAt: null, teamId },
  });
  return rows.map((r) => r.userId);
}

/**
 * Filters a list of userIds to those who have opted in to sharing metadata
 * with the given scope. Users with no policy row default to opted-in (true).
 */
async function filterByPolicy(
  userIds: string[],
  field: 'shareMetadataWithOrg' | 'shareMetadataWithTeam',
): Promise<string[]> {
  if (userIds.length === 0) {
    return [];
  }

  const policies = await getPrisma().visibilityPolicy.findMany({
    select: { shareMetadataWithOrg: true, shareMetadataWithTeam: true, userId: true },
    where: { userId: { in: userIds } },
  });
  const policyMap = new Map(policies.map((p) => [p.userId, p]));

  return userIds.filter((id) => {
    const p = policyMap.get(id);
    if (!p) {
      return true; // default: share
    }
    return field === 'shareMetadataWithOrg' ? p.shareMetadataWithOrg : p.shareMetadataWithTeam;
  });
}

/**
 * Returns the total active member count and the subset whose shareMetadataWithTeam
 * policy allows team-lead-visible data. Call once per page and pass visibleIds down
 * to the individual query functions to avoid redundant DB round-trips.
 */
export async function resolveTeamVisibility(
  teamId: string,
): Promise<{ totalCount: number; visibleIds: string[] }> {
  const allIds = await activeTeamMemberIds(teamId);
  const visibleIds = await filterByPolicy(allIds, 'shareMetadataWithTeam');
  return { totalCount: allIds.length, visibleIds };
}

async function getTeamSummaryWindow(
  since: Date,
  until: Date | undefined,
  visibleIds: string[],
  totalMemberCount: number,
): Promise<TeamSummary> {
  if (visibleIds.length === 0) {
    return {
      activeMembers: totalMemberCount,
      cacheHitRate: 0,
      sessionCount: 0,
      totalCostUsd: 0,
      totalHours: 0,
    };
  }

  const prisma = getPrisma();
  const uuids = toUuidList(visibleIds);

  const untilClause = until ? Prisma.sql`AND started_at < ${until}` : Prisma.sql``;
  const untilClauseEnded = until ? Prisma.sql`AND started_at < ${until}` : Prisma.sql``;

  const [agg, [statsRow]] = await Promise.all([
    prisma.session.aggregate({
      _count: { sessionId: true },
      _sum: { totalCostUsd: true },
      where: {
        startedAt: { gte: since, ...(until ? { lt: until } : {}) },
        userId: { in: visibleIds },
      },
    }),
    prisma.$queryRaw<
      [{ cache_read: bigint; input_tokens: bigint; total_seconds: number }]
    >(Prisma.sql`
      SELECT
        COALESCE(EXTRACT(EPOCH FROM SUM(ended_at - started_at)), 0) AS total_seconds,
        COALESCE(SUM(total_cache_read), 0)                          AS cache_read,
        COALESCE(SUM(total_input_tokens), 0)                        AS input_tokens
      FROM sessions
      WHERE user_id IN (${uuids})
        AND started_at >= ${since}
        ${untilClause}
        AND ended_at IS NOT NULL
    `),
  ]);

  // For cache hit rate the denominator includes all sessions (not just ended ones),
  // so run a second aggregate that doesn't filter on ended_at.
  const [cacheRow] = await prisma.$queryRaw<
    [{ cache_read: bigint; input_tokens: bigint }]
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(total_cache_read), 0)    AS cache_read,
      COALESCE(SUM(total_input_tokens), 0)  AS input_tokens
    FROM sessions
    WHERE user_id IN (${uuids})
      AND started_at >= ${since}
      ${untilClauseEnded}
  `);

  const cacheRead = Number(cacheRow?.cache_read ?? 0);
  const inputTokens = Number(cacheRow?.input_tokens ?? 0);
  const denom = inputTokens + cacheRead;
  const cacheHitRate = denom > 0 ? (cacheRead / denom) * 100 : 0;

  return {
    activeMembers: totalMemberCount,
    cacheHitRate,
    sessionCount: agg._count.sessionId,
    totalCostUsd: Number(agg._sum.totalCostUsd ?? 0),
    totalHours: Number(statsRow?.total_seconds ?? 0) / 3600,
  };
}

export async function getTeamSummary(
  since: Date,
  visibleIds: string[],
  totalMemberCount: number,
): Promise<TeamSummary> {
  return getTeamSummaryWindow(since, undefined, visibleIds, totalMemberCount);
}

export async function getTeamTopTools(
  since: Date,
  visibleIds: string[],
  limit = 5,
): Promise<TeamToolUsage[]> {
  if (visibleIds.length === 0) {
    return [];
  }

  const uuids = toUuidList(visibleIds);
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

export async function getTeamModelMix(since: Date, visibleIds: string[]): Promise<TeamModelMix[]> {
  if (visibleIds.length === 0) {
    return [];
  }

  const prisma = getPrisma();
  const uuids = toUuidList(visibleIds);

  const [sessionRows, turnsRows] = await Promise.all([
    prisma.$queryRaw<{ cost_usd: string; primary_model: string | null; session_count: bigint }[]>(
      Prisma.sql`
        SELECT
          primary_model,
          COUNT(*)                          AS session_count,
          COALESCE(SUM(total_cost_usd), 0) AS cost_usd
        FROM sessions
        WHERE user_id IN (${uuids})
          AND started_at >= ${since}
        GROUP BY primary_model
      `,
    ),
    prisma.$queryRaw<{ model: string; turns: bigint }[]>(Prisma.sql`
      SELECT model, COUNT(*) AS turns
      FROM events
      WHERE user_id IN (${uuids})
        AND ts >= ${since}
        AND model IS NOT NULL
      GROUP BY model
    `),
  ]);

  const turnsMap = new Map(turnsRows.map((r) => [r.model, Number(r.turns)]));

  return sessionRows
    .map((r) => {
      const model = r.primary_model ?? 'unknown';
      return {
        costUsd: Number(r.cost_usd),
        model,
        sessionCount: Number(r.session_count),
        turns: turnsMap.get(model) ?? 0,
      };
    })
    .sort((a, b) => b.turns - a.turns);
}

export type MemberProfile = {
  canViewStats: boolean;
  canViewTranscripts: boolean;
  displayName: string | null;
  githubLogin: string | null;
  role: string;
  userId: string;
};

export async function getMemberForTeam(
  teamId: string,
  githubLogin: string,
): Promise<MemberProfile | null> {
  const membership = await getPrisma().teamMember.findFirst({
    include: {
      user: { include: { visibilityPolicy: true } },
    },
    where: {
      leftAt: null,
      teamId,
      user: { githubLogin },
    },
  });
  if (!membership) {
    return null;
  }
  return {
    canViewStats: membership.user.visibilityPolicy?.shareMetadataWithTeam ?? true,
    canViewTranscripts: membership.user.visibilityPolicy?.shareTranscriptsWithTeam ?? false,
    displayName: membership.user.displayName,
    githubLogin: membership.user.githubLogin,
    role: membership.roleInTeam as string,
    userId: membership.userId,
  };
}

export async function getTeamRoster(teamId: string, since: Date): Promise<RosterMember[]> {
  const prisma = getPrisma();

  const memberships = await prisma.teamMember.findMany({
    include: {
      user: { include: { visibilityPolicy: true } },
    },
    orderBy: [{ user: { displayName: 'asc' } }, { user: { githubLogin: 'asc' } }],
    where: { leftAt: null, teamId },
  });

  const visibleIds: string[] = [];
  const members: RosterMember[] = memberships.map((m) => {
    const canViewStats = m.user.visibilityPolicy?.shareMetadataWithTeam ?? true;
    if (canViewStats) {
      visibleIds.push(m.userId);
    }
    return {
      canViewStats,
      displayName: m.user.displayName,
      githubLogin: m.user.githubLogin,
      role: m.roleInTeam as string,
      sessionCount: null,
      totalCostUsd: null,
      userId: m.userId,
    };
  });

  if (visibleIds.length > 0) {
    const stats = await prisma.session.groupBy({
      _count: { sessionId: true },
      _sum: { totalCostUsd: true },
      by: ['userId'],
      where: { startedAt: { gte: since }, userId: { in: visibleIds } },
    });
    const statsMap = new Map(
      stats.map((s) => [
        s.userId,
        { cost: Number(s._sum.totalCostUsd ?? 0), count: s._count.sessionId },
      ]),
    );

    for (const m of members) {
      if (m.canViewStats) {
        const s = statsMap.get(m.userId);
        m.sessionCount = s?.count ?? 0;
        m.totalCostUsd = s?.cost ?? 0;
      }
    }
  }

  return members;
}

// ── Feature B + E: delta-aware summary ────────────────────────────────────────

export async function getTeamSummaryWithDelta(
  range: number,
  visibleIds: string[],
  totalMemberCount: number,
): Promise<{
  current: TeamSummary;
  deltas: {
    activeMembers: number | null;
    cacheHitRate: number | null;
    sessionCount: number | null;
    totalCostUsd: number | null;
    totalHours: number | null;
  };
}> {
  const currentStart = daysAgo(range);
  const priorStart = daysAgo(2 * range);
  const priorEnd = currentStart;

  const [current, prior] = await Promise.all([
    getTeamSummaryWindow(currentStart, undefined, visibleIds, totalMemberCount),
    getTeamSummaryWindow(priorStart, priorEnd, visibleIds, totalMemberCount),
  ]);

  const delta = (cur: number, prev: number): number | null =>
    prev > 0 ? (cur - prev) / prev : null;

  // For activeMembers, compute distinct active users per window rather than
  // returning the static roster count for both periods.
  let activeMembersDelta: number | null = null;
  if (visibleIds.length > 0) {
    const uuids = toUuidList(visibleIds);
    const [curActiveRow, priorActiveRow] = await Promise.all([
      getPrisma().$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT user_id) AS cnt
        FROM sessions
        WHERE user_id IN (${uuids})
          AND started_at >= ${currentStart}
      `),
      getPrisma().$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT user_id) AS cnt
        FROM sessions
        WHERE user_id IN (${uuids})
          AND started_at >= ${priorStart}
          AND started_at < ${priorEnd}
      `),
    ]);
    const curActive = Number(curActiveRow[0]?.cnt ?? 0);
    const priorActive = Number(priorActiveRow[0]?.cnt ?? 0);
    activeMembersDelta = delta(curActive, priorActive);
  }

  return {
    current,
    deltas: {
      activeMembers: activeMembersDelta,
      cacheHitRate: delta(current.cacheHitRate, prior.cacheHitRate),
      sessionCount: delta(current.sessionCount, prior.sessionCount),
      totalCostUsd: delta(current.totalCostUsd, prior.totalCostUsd),
      totalHours: delta(current.totalHours, prior.totalHours),
    },
  };
}

// ── Feature C: merged PR rollups ───────────────────────────────────────────────

export type TeamPrRollupRow = {
  authorGithubLogin: string;
  mergedAt: Date;
  prNumber: number;
  repoName: string;
  repoOwner: string;
  sessionCount: number;
  timeToMergeHours: number | null;
  title: string | null;
  totalCostUsd: number;
};

export async function getTeamPrRollups(
  since: Date,
  visibleIds: string[],
  limit = 50,
): Promise<TeamPrRollupRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }

  const uuids = toUuidList(visibleIds);

  const rows = await getPrisma().$queryRaw<
    {
      author_github_login: string;
      merged_at: Date;
      pr_number: number;
      repo_name: string;
      repo_owner: string;
      session_count: bigint;
      time_to_merge_hours: number | null;
      title: string | null;
      total_cost_usd: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      r.github_owner                                          AS repo_owner,
      r.github_name                                          AS repo_name,
      p.pr_number,
      p.title,
      p.author_github_login,
      p.merged_at,
      COALESCE(pr.total_cost_usd, 0)                         AS total_cost_usd,
      COUNT(DISTINCT spl.session_id)                         AS session_count,
      CASE
        WHEN p.opened_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (p.merged_at - p.opened_at)) / 3600
        ELSE NULL
      END                                                    AS time_to_merge_hours
    FROM pull_requests p
    JOIN repos r ON r.id = p.repo_id
    LEFT JOIN pr_rollups pr ON pr.repo_id = p.repo_id AND pr.pr_number = p.pr_number
    JOIN session_pr_links spl ON spl.repo_id = p.repo_id AND spl.pr_number = p.pr_number
    JOIN sessions s ON s.session_id = spl.session_id
    JOIN users u ON u.id = s.user_id
    WHERE p.state = 'MERGED'
      AND p.merged_at >= ${since}
      AND p.merged_at IS NOT NULL
      AND u.id IN (${uuids})
    GROUP BY
      p.repo_id,
      p.pr_number,
      r.github_owner,
      r.github_name,
      p.title,
      p.author_github_login,
      p.merged_at,
      p.opened_at,
      pr.total_cost_usd
    ORDER BY p.merged_at DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    authorGithubLogin: r.author_github_login,
    mergedAt: r.merged_at,
    prNumber: r.pr_number,
    repoName: r.repo_name,
    repoOwner: r.repo_owner,
    sessionCount: Number(r.session_count),
    timeToMergeHours: r.time_to_merge_hours !== null ? Number(r.time_to_merge_hours) : null,
    title: r.title,
    totalCostUsd: Number(r.total_cost_usd ?? 0),
  }));
}

export type TeamSessionRow = SessionRow & {
  ownerDisplayName: string | null;
  ownerLogin: string | null;
};

const TEAM_PAGE_SIZE = 50;

export async function listTeamSessions(
  visibleIds: string[],
  opts: { page: number },
): Promise<{ sessions: TeamSessionRow[]; total: number }> {
  if (visibleIds.length === 0) {
    return { sessions: [], total: 0 };
  }
  const prisma = getPrisma();
  const safePage = Math.max(1, opts.page);
  const where = { userId: { in: visibleIds } };

  const [total, rows] = await Promise.all([
    prisma.session.count({ where }),
    prisma.session.findMany({
      include: {
        repo: { select: { githubName: true, githubOwner: true } },
        user: { select: { displayName: true, githubLogin: true } },
      },
      orderBy: { startedAt: 'desc' },
      skip: (safePage - 1) * TEAM_PAGE_SIZE,
      take: TEAM_PAGE_SIZE,
      where,
    }),
  ]);

  return {
    sessions: rows.map((s) => ({
      costUsd: Number(s.totalCostUsd),
      durationSeconds: s.endedAt
        ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000)
        : null,
      endedAt: s.endedAt,
      eventCount: s.toolCallCount + s.userMessageCount,
      frictionScore: s.frictionScore,
      ownerDisplayName: s.user.displayName,
      ownerLogin: s.user.githubLogin,
      repoName: s.repo ? `${s.repo.githubOwner}/${s.repo.githubName}` : null,
      sessionId: s.sessionId,
      shapeLabel: s.shapeLabel,
      startedAt: s.startedAt,
      status: s.status,
    })),
    total,
  };
}

// ── Team-scoped tool & skill queries ─────────────────────────────────────────
// These adapt the equivalent org-queries functions to accept a pre-resolved
// visibleIds array (from resolveTeamVisibility) instead of querying all org users.

export async function getTeamToolStats(
  visibleIds: string[],
  since: Date,
  limit = 20,
): Promise<ToolStatRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
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
      COUNT(*)                                         AS call_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)   AS deny_count,
      AVG(tool_duration_ms)                            AS avg_duration_ms,
      COUNT(DISTINCT user_id)                          AS distinct_users
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

export async function getTeamToolCategoryBreakdown(
  visibleIds: string[],
  since: Date,
): Promise<CategoryStatRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
  const rows = await getPrisma().$queryRaw<
    { call_count: bigint; category: string; deny_count: bigint }[]
  >(Prisma.sql`
    SELECT
      COALESCE(tool_category, 'other')                 AS category,
      COUNT(*)                                         AS call_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)   AS deny_count
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

export async function getTeamDailyToolVolume(
  visibleIds: string[],
  since: Date,
): Promise<DailyToolVolumeRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
  const rows = await getPrisma().$queryRaw<
    { call_count: bigint; day: Date; deny_count: bigint; distinct_users: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', ts)                            AS day,
      COUNT(*)                                         AS call_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)   AS deny_count,
      COUNT(DISTINCT user_id)                          AS distinct_users
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

export async function getTeamSkillUsage(visibleIds: string[], since: Date): Promise<SkillRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
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
        COALESCE(skill_name, slash_command)                             AS name,
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
      SUM(i.invocation_count)::bigint     AS call_count,
      COUNT(DISTINCT i.user_id)::bigint   AS distinct_users,
      AVG(s.total_cost_usd)::text         AS avg_session_cost_usd
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

export type TeamPRDeliveryStats = {
  avgCostPerPR: number;
  medianCostPerPR: number | null;
  medianTimeToMergeHours: number | null;
  mergeRate: number;
  mergedPRs: number;
  revertRate: number;
  revertedPRs: number;
  totalPRs: number;
};

export async function getTeamPRDeliveryStats(
  visibleIds: string[],
  since: Date,
): Promise<TeamPRDeliveryStats> {
  const empty: TeamPRDeliveryStats = {
    avgCostPerPR: 0,
    medianCostPerPR: null,
    medianTimeToMergeHours: null,
    mergedPRs: 0,
    mergeRate: 0,
    revertedPRs: 0,
    revertRate: 0,
    totalPRs: 0,
  };
  if (visibleIds.length === 0) {
    return empty;
  }
  const uuids = toUuidList(visibleIds);
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
    WITH team_prs AS (
      SELECT DISTINCT
        p.github_id,
        p.state,
        p.opened_at,
        p.merged_at,
        p.reverted_at,
        pr.total_cost_usd
      FROM pull_requests p
      LEFT JOIN pr_rollups pr ON pr.repo_id = p.repo_id AND pr.pr_number = p.pr_number
      JOIN session_pr_links spl ON spl.repo_id = p.repo_id AND spl.pr_number = p.pr_number
      JOIN sessions s ON s.session_id = spl.session_id
      WHERE p.opened_at >= ${since}
        AND s.user_id IN (${uuids})
    )
    SELECT
      COUNT(*)                                                              AS total_prs,
      COUNT(*) FILTER (WHERE state = 'MERGED')                             AS merged_prs,
      COUNT(*) FILTER (WHERE reverted_at IS NOT NULL)                      AS reverted_prs,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (merged_at - opened_at)) / 3600
      ) FILTER (WHERE state = 'MERGED' AND opened_at IS NOT NULL
                  AND merged_at IS NOT NULL)                               AS median_ttm_hours,
      AVG(total_cost_usd)                                                  AS avg_cost_per_pr,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_cost_usd)         AS median_cost_per_pr
    FROM team_prs
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

const FREQ_BUCKET_ORDER = [
  'Inactive',
  'Light (1–4)',
  'Moderate (5–19)',
  'Active (20–49)',
  'Power (50+)',
] as const;

export type TeamFrequencyBucket = { bucket: string; userCount: number };

export async function getTeamSessionFrequencyDistribution(
  visibleIds: string[],
  since: Date,
): Promise<TeamFrequencyBucket[]> {
  if (visibleIds.length === 0) {
    return FREQ_BUCKET_ORDER.map((b) => ({ bucket: b, userCount: 0 }));
  }
  const uuids = toUuidList(visibleIds);
  const rows = await getPrisma().$queryRaw<{ bucket: string; user_count: bigint }[]>(Prisma.sql`
    WITH per_user AS (
      SELECT
        u.id,
        COUNT(s.session_id) AS session_count
      FROM users u
      LEFT JOIN sessions s
        ON s.user_id = u.id
        AND s.started_at >= ${since}
      WHERE u.id IN (${uuids})
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
  return FREQ_BUCKET_ORDER.map((b) => ({ bucket: b, userCount: map.get(b) ?? 0 }));
}

// ── Team-scoped skill detail queries ─────────────────────────────────────────

export async function getTeamSkillAdoptionFunnel(
  visibleIds: string[],
  since: Date,
): Promise<SkillAdoptionRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
  const rows = await getPrisma().$queryRaw<
    { name: string; new_users: bigint; recent_users: bigint; returning_users: bigint }[]
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
      COUNT(DISTINCT ru.user_id)::bigint                                         AS recent_users,
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

export async function getTeamDailySkillVolume(
  visibleIds: string[],
  since: Date,
): Promise<DailySkillVolumeRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
  const rows = await getPrisma().$queryRaw<
    { day: Date; distinct_users: bigint; invocation_count: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', ts)           AS day,
      COUNT(*)::bigint                AS invocation_count,
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

export async function getTeamSkillDailyTrend(
  visibleIds: string[],
  name: string,
  kind: 'skill' | 'slash',
  since: Date,
): Promise<DailySkillVolumeRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
  const rows = await getPrisma().$queryRaw<
    { day: Date; distinct_users: bigint; invocation_count: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', ts)           AS day,
      COUNT(*)::bigint                AS invocation_count,
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

export async function getTeamSkillTopUsers(
  visibleIds: string[],
  name: string,
  kind: 'skill' | 'slash',
  since: Date,
): Promise<SkillTopUserRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
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
      AND u.github_login IS NOT NULL
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

export async function getTeamSkillCostComparison(
  visibleIds: string[],
  name: string,
  kind: 'skill' | 'slash',
  since: Date,
): Promise<SkillCostComparisonRow[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const uuids = toUuidList(visibleIds);
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

export type { DailySkillVolumeRow, SkillAdoptionRow, SkillCostComparisonRow, SkillTopUserRow };
