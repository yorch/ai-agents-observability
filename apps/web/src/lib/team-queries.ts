import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';
import { labelToolRows } from './tool-usage';

const toUuidList = (ids: string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

export type TeamSummary = {
  activeMembers: number;
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

export async function getTeamSummary(
  since: Date,
  visibleIds: string[],
  totalMemberCount: number,
): Promise<TeamSummary> {
  if (visibleIds.length === 0) {
    return { activeMembers: totalMemberCount, sessionCount: 0, totalCostUsd: 0, totalHours: 0 };
  }

  const prisma = getPrisma();
  const uuids = toUuidList(visibleIds);

  const [agg, [hoursRow]] = await Promise.all([
    prisma.session.aggregate({
      _count: { sessionId: true },
      _sum: { totalCostUsd: true },
      where: { startedAt: { gte: since }, userId: { in: visibleIds } },
    }),
    prisma.$queryRaw<[{ total_seconds: number }]>(Prisma.sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM SUM(ended_at - started_at)), 0) AS total_seconds
      FROM sessions
      WHERE user_id IN (${uuids})
        AND started_at >= ${since}
        AND ended_at IS NOT NULL
    `),
  ]);

  return {
    activeMembers: totalMemberCount,
    sessionCount: agg._count.sessionId,
    totalCostUsd: Number(agg._sum.totalCostUsd ?? 0),
    totalHours: Number(hoursRow?.total_seconds ?? 0) / 3600,
  };
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
