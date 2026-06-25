import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';
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
