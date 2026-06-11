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
  sessionCount: number;
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

  const [sessionRows, turnsRows] = await Promise.all([
    prisma.$queryRaw<
      {
        cost_usd: string;
        input_tokens: bigint;
        output_tokens: bigint;
        primary_model: string | null;
        session_count: bigint;
      }[]
    >(Prisma.sql`
      SELECT
        primary_model,
        COUNT(*)                              AS session_count,
        COALESCE(SUM(total_cost_usd), 0)      AS cost_usd,
        COALESCE(SUM(total_input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(total_output_tokens), 0) AS output_tokens
      FROM sessions
      WHERE user_id = ${userId}::uuid
        AND started_at >= ${since}
      GROUP BY primary_model
    `),
    prisma.$queryRaw<{ model: string; turns: bigint }[]>(Prisma.sql`
      SELECT model, COUNT(*) AS turns
      FROM events
      WHERE user_id = ${userId}::uuid
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
        inputTokens: r.input_tokens,
        model,
        outputTokens: r.output_tokens,
        sessionCount: Number(r.session_count),
        turns: turnsMap.get(model) ?? 0,
      };
    })
    .sort((a, b) => b.turns - a.turns);
}

export type AuditRow = {
  action: string;
  actorLogin: string | null;
  id: bigint;
  ip: string | null;
  justification: string | null;
  targetSessionId: string | null;
  targetTeamId: string | null;
  targetUserId: string | null;
  ts: Date;
};

export async function getAuditLog(
  userId: string,
  filters: { action?: string; since?: Date },
  page: number,
  pageSize = 25,
): Promise<{ rows: AuditRow[]; total: number }> {
  const prisma = getPrisma();
  const where = {
    targetUserId: userId,
    // Cast to `never` avoids the AuditAction import (generated client not committed to repo).
    ...(filters.action ? { action: filters.action as never } : {}),
    ...(filters.since ? { ts: { gte: filters.since } } : {}),
  };

  type RawRow = {
    action: string;
    actor: { githubLogin: string | null };
    id: bigint;
    ip: string | null;
    justification: string | null;
    targetSessionId: string | null;
    targetTeamId: string | null;
    targetUserId: string | null;
    ts: Date;
  };

  const [total, rawRows]: [number, RawRow[]] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      include: { actor: { select: { githubLogin: true } } },
      orderBy: { ts: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      where,
    }),
  ]);

  return {
    rows: rawRows.map((r) => ({
      action: r.action,
      actorLogin: r.actor.githubLogin,
      id: r.id,
      ip: r.ip,
      justification: r.justification,
      targetSessionId: r.targetSessionId,
      targetTeamId: r.targetTeamId,
      targetUserId: r.targetUserId,
      ts: r.ts,
    })),
    total,
  };
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
