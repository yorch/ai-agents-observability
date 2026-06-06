import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

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
  turns: number;
};

export type RosterMember = {
  canViewStats: boolean;
  displayName: string | null;
  githubLogin: string;
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

export async function getTeamSummary(teamId: string, since: Date): Promise<TeamSummary> {
  const prisma = getPrisma();

  const [allMemberIds, totalMembers] = await Promise.all([
    activeTeamMemberIds(teamId),
    prisma.teamMember.count({ where: { leftAt: null, teamId } }),
  ]);

  const visibleIds = await filterByPolicy(allMemberIds, 'shareMetadataWithOrg');
  if (visibleIds.length === 0) {
    return { activeMembers: totalMembers, sessionCount: 0, totalCostUsd: 0, totalHours: 0 };
  }

  const [agg, sessions] = await Promise.all([
    prisma.session.aggregate({
      _count: { sessionId: true },
      _sum: { totalCostUsd: true },
      where: { startedAt: { gte: since }, userId: { in: visibleIds } },
    }),
    prisma.session.findMany({
      select: { endedAt: true, startedAt: true },
      where: { startedAt: { gte: since }, userId: { in: visibleIds } },
    }),
  ]);

  let totalMs = 0;
  for (const s of sessions) {
    if (s.endedAt) {
      totalMs += s.endedAt.getTime() - s.startedAt.getTime();
    }
  }

  return {
    activeMembers: totalMembers,
    sessionCount: agg._count.sessionId,
    totalCostUsd: Number(agg._sum.totalCostUsd ?? 0),
    totalHours: totalMs / (1000 * 60 * 60),
  };
}

export async function getTeamTopTools(
  teamId: string,
  since: Date,
  limit = 5,
): Promise<TeamToolUsage[]> {
  const allMemberIds = await activeTeamMemberIds(teamId);
  const visibleIds = await filterByPolicy(allMemberIds, 'shareMetadataWithOrg');
  if (visibleIds.length === 0) {
    return [];
  }

  const uuids = Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<{ call_count: bigint; tool_name: string }[]>(Prisma.sql`
    SELECT tool_name, COUNT(*) AS call_count
    FROM events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY call_count DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({ callCount: Number(r.call_count), toolName: r.tool_name }));
}

export async function getTeamModelMix(teamId: string, since: Date): Promise<TeamModelMix[]> {
  const allMemberIds = await activeTeamMemberIds(teamId);
  const visibleIds = await filterByPolicy(allMemberIds, 'shareMetadataWithOrg');
  if (visibleIds.length === 0) {
    return [];
  }

  const sessions = await getPrisma().session.findMany({
    select: {
      haikuTurns: true,
      opusTurns: true,
      primaryModel: true,
      sonnetTurns: true,
      totalCostUsd: true,
    },
    where: { startedAt: { gte: since }, userId: { in: visibleIds } },
  });

  const modelMap = new Map<string, { costUsd: number; turns: number }>();
  for (const s of sessions) {
    const model = s.primaryModel ?? 'unknown';
    const existing = modelMap.get(model) ?? { costUsd: 0, turns: 0 };
    modelMap.set(model, {
      costUsd: existing.costUsd + Number(s.totalCostUsd),
      turns: existing.turns + s.opusTurns + s.sonnetTurns + s.haikuTurns,
    });
  }

  return Array.from(modelMap.entries())
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.turns - a.turns);
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
