import type { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type UsageSummary = {
  repoCount: number;
  sessionCount: number;
  totalCostUsd: number;
  totalHours: number;
};

export type ToolUsage = {
  callCount: number;
  toolName: string;
};

export type ModelMix = {
  costUsd: number;
  inputTokens: bigint;
  model: string;
  outputTokens: bigint;
  turns: number;
};

export type RecentSession = {
  costUsd: number;
  durationSeconds: number | null;
  endedAt: Date | null;
  repoName: string | null;
  sessionId: string;
  startedAt: Date;
  status: string;
};

export async function getUsageSummary(
  userId: string,
  since: Date,
  until?: Date,
): Promise<UsageSummary> {
  const prisma = getPrisma();
  const where: Prisma.SessionWhereInput = {
    startedAt: {
      gte: since,
      ...(until ? { lt: until } : {}),
    },
    userId,
  };

  const agg = await prisma.session.aggregate({
    _count: { sessionId: true },
    _sum: { totalCostUsd: true },
    where,
  });

  const sessions = await prisma.session.findMany({
    select: {
      endedAt: true,
      repoId: true,
      startedAt: true,
    },
    where,
  });

  const uniqueRepos = new Set(sessions.map((s) => s.repoId).filter(Boolean));

  // Calculate total hours from session durations
  let totalMs = 0;
  for (const s of sessions) {
    if (s.endedAt) {
      totalMs += s.endedAt.getTime() - s.startedAt.getTime();
    }
  }

  return {
    repoCount: uniqueRepos.size,
    sessionCount: agg._count.sessionId,
    totalCostUsd: Number(agg._sum.totalCostUsd ?? 0),
    totalHours: totalMs / (1000 * 60 * 60),
  };
}

export async function getTopTools(
  userId: string,
  since: Date,
  limit = 5,
): Promise<ToolUsage[]> {
  const prisma = getPrisma();

  // Aggregate tool call count by primary model as a proxy
  // Real tool-level breakdown would need a JSON aggregation on toolUsage field
  // For now, aggregate by session and sum toolCallCount grouped by session type
  // Since toolUsage is not a JSON field in the schema, we aggregate sessions
  const sessions = await prisma.session.findMany({
    select: {
      primaryModel: true,
      toolCallCount: true,
    },
    where: {
      startedAt: { gte: since },
      userId,
    },
  });

  // Group by primaryModel as a tool usage proxy
  const toolMap = new Map<string, number>();
  for (const s of sessions) {
    const key = s.primaryModel ?? 'unknown';
    toolMap.set(key, (toolMap.get(key) ?? 0) + s.toolCallCount);
  }

  return Array.from(toolMap.entries())
    .map(([toolName, callCount]) => ({ callCount, toolName }))
    .sort((a, b) => b.callCount - a.callCount)
    .slice(0, limit);
}

export async function getModelMix(
  userId: string,
  since: Date,
): Promise<ModelMix[]> {
  const prisma = getPrisma();

  const sessions = await prisma.session.findMany({
    select: {
      haikuTurns: true,
      opusTurns: true,
      primaryModel: true,
      sonnetTurns: true,
      totalCostUsd: true,
      totalInputTokens: true,
      totalOutputTokens: true,
    },
    where: {
      startedAt: { gte: since },
      userId,
    },
  });

  const modelMap = new Map<
    string,
    { costUsd: number; inputTokens: bigint; outputTokens: bigint; turns: number }
  >();

  for (const s of sessions) {
    const model = s.primaryModel ?? 'unknown';
    const existing = modelMap.get(model) ?? {
      costUsd: 0,
      inputTokens: 0n,
      outputTokens: 0n,
      turns: 0,
    };
    const turns = s.opusTurns + s.sonnetTurns + s.haikuTurns;
    modelMap.set(model, {
      costUsd: existing.costUsd + Number(s.totalCostUsd),
      inputTokens: existing.inputTokens + s.totalInputTokens,
      outputTokens: existing.outputTokens + s.totalOutputTokens,
      turns: existing.turns + turns,
    });
  }

  return Array.from(modelMap.entries())
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.turns - a.turns);
}

export async function getRecentSessions(
  userId: string,
  limit = 10,
): Promise<RecentSession[]> {
  const prisma = getPrisma();

  const sessions = await prisma.session.findMany({
    include: {
      repo: {
        select: { githubName: true, githubOwner: true },
      },
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
    where: { userId },
  });

  return sessions.map((s) => {
    const durationSeconds =
      s.endedAt
        ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000)
        : null;
    return {
      costUsd: Number(s.totalCostUsd),
      durationSeconds,
      endedAt: s.endedAt,
      repoName: s.repo ? `${s.repo.githubOwner}/${s.repo.githubName}` : null,
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      status: s.status,
    };
  });
}
