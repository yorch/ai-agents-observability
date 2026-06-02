import { Prisma } from '@ai-agents-observability/db';
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

export async function getTopTools(userId: string, since: Date, limit = 5): Promise<ToolUsage[]> {
  const prisma = getPrisma();

  // Real per-tool breakdown from the events firehose. We count PostToolUse events
  // (one per completed tool call, matching sessions.tool_call_count semantics) so
  // PreToolUse doesn't double-count. Previously this grouped sessions by
  // primary_model and mislabeled model names as tools.
  const rows = await prisma.$queryRaw<{ call_count: bigint; tool_name: string }[]>(Prisma.sql`
    SELECT tool_name, COUNT(*) AS call_count
    FROM events
    WHERE user_id = ${userId}::uuid
      AND ts >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY call_count DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({ callCount: Number(r.call_count), toolName: r.tool_name }));
}

export async function getModelMix(userId: string, since: Date): Promise<ModelMix[]> {
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

export async function getRecentSessions(userId: string, limit = 10): Promise<RecentSession[]> {
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
    const durationSeconds = s.endedAt
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
