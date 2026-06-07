import { type $Enums, Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type ModelBreakdownRow = {
  // Number of LLM-bearing events recorded for this model — not logical turns.
  calls: number;
  inputTokens: bigint;
  model: string;
  outputTokens: bigint;
};

const VALID_STATUSES = new Set<string>([
  'active',
  'completed',
  'crashed',
  'timed_out',
  'abandoned',
]);

const MAX_PAGE = 10_000;

export type SessionRow = {
  costUsd: number;
  durationSeconds: number | null;
  endedAt: Date | null;
  eventCount: number;
  frictionScore: number | null;
  repoName: string | null;
  sessionId: string;
  shapeLabel: string | null;
  startedAt: Date;
  status: string;
};

export type SessionDetail = {
  agentVersion: string | null;
  branch: string | null;
  claudeCodeVersion: string | null;
  commitSha: string | null;
  costUsd: number;
  durationSeconds: number | null;
  endedAt: Date | null;
  endReason: string | null;
  frictionScore: number | null;
  inputTokens: bigint;
  interruptCount: number;
  os: string | null;
  outputTokens: bigint;
  permissionDenyCount: number;
  permissionPromptCount: number;
  primaryModel: string | null;
  repoName: string | null;
  sessionId: string;
  shapeLabel: string | null;
  startedAt: Date;
  status: string;
  toolCallCount: number;
  toolErrorCount: number;
  transcriptS3Key: string | null;
  userMessageCount: number;
};

const PAGE_SIZE = 50;

export async function listSessions(
  userId: string,
  opts: {
    dateFrom?: Date;
    dateTo?: Date;
    page: number;
    repo?: string;
    status?: string;
  },
): Promise<{ sessions: SessionRow[]; total: number }> {
  const prisma = getPrisma();

  const safePage = Math.min(Math.max(1, opts.page), MAX_PAGE);
  const validatedStatus =
    opts.status && VALID_STATUSES.has(opts.status)
      ? (opts.status as $Enums.SessionStatus)
      : undefined;

  const where: Prisma.SessionWhereInput = {
    userId,
    ...(validatedStatus ? { status: validatedStatus } : {}),
    ...(opts.dateFrom || opts.dateTo
      ? {
          startedAt: {
            ...(opts.dateFrom ? { gte: opts.dateFrom } : {}),
            ...(opts.dateTo ? { lte: opts.dateTo } : {}),
          },
        }
      : {}),
    ...(opts.repo
      ? {
          repo: {
            OR: [
              { githubName: { contains: opts.repo, mode: 'insensitive' } },
              { githubOwner: { contains: opts.repo, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.session.count({ where }),
    prisma.session.findMany({
      include: {
        repo: { select: { githubName: true, githubOwner: true } },
      },
      orderBy: { startedAt: 'desc' },
      skip: (safePage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      where,
    }),
  ]);

  const sessions: SessionRow[] = rows.map((s) => ({
    costUsd: Number(s.totalCostUsd),
    durationSeconds: s.endedAt
      ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000)
      : null,
    endedAt: s.endedAt,
    eventCount: s.toolCallCount + s.userMessageCount,
    frictionScore: s.frictionScore,
    repoName: s.repo ? `${s.repo.githubOwner}/${s.repo.githubName}` : null,
    sessionId: s.sessionId,
    shapeLabel: s.shapeLabel,
    startedAt: s.startedAt,
    status: s.status,
  }));

  return { sessions, total };
}

export async function getSession(userId: string, sessionId: string): Promise<SessionDetail | null> {
  const prisma = getPrisma();

  const s = await prisma.session.findFirst({
    include: {
      repo: { select: { githubName: true, githubOwner: true } },
    },
    where: { sessionId, userId },
  });

  if (!s) {
    return null;
  }

  return {
    agentVersion: s.agentVersion,
    branch: s.gitBranch,
    claudeCodeVersion: s.claudeCodeVersion,
    commitSha: s.gitCommit,
    costUsd: Number(s.totalCostUsd),
    durationSeconds: s.endedAt
      ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000)
      : null,
    endedAt: s.endedAt,
    endReason: s.endReason,
    frictionScore: s.frictionScore,
    inputTokens: s.totalInputTokens,
    interruptCount: s.interruptCount,
    os: s.os,
    outputTokens: s.totalOutputTokens,
    permissionDenyCount: s.permissionDenyCount,
    permissionPromptCount: s.permissionPromptCount,
    primaryModel: s.primaryModel,
    repoName: s.repo ? `${s.repo.githubOwner}/${s.repo.githubName}` : null,
    sessionId: s.sessionId,
    shapeLabel: s.shapeLabel,
    startedAt: s.startedAt,
    status: s.status,
    toolCallCount: s.toolCallCount,
    toolErrorCount: s.toolErrorCount,
    transcriptS3Key: s.transcriptS3Key,
    userMessageCount: s.userMessageCount,
  };
}

/**
 * Real per-model token/turn breakdown for a session, from the events firehose.
 * The sessions row only has per-model TURN counts and session-total tokens — not
 * per-model token splits — so a truthful model table must aggregate events by
 * `model`. Scoped by userId as defense-in-depth (callers already own-check).
 */
export async function getSessionModelBreakdown(
  userId: string,
  sessionId: string,
): Promise<ModelBreakdownRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<
    { calls: bigint; input_tokens: bigint | null; model: string; output_tokens: bigint | null }[]
  >(Prisma.sql`
    SELECT model,
           COUNT(*) AS calls,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM events
    WHERE session_id = ${sessionId}::uuid
      AND user_id = ${userId}::uuid
      AND model IS NOT NULL
    GROUP BY model
    ORDER BY calls DESC
  `);

  return rows.map((r) => ({
    calls: Number(r.calls),
    inputTokens: r.input_tokens ?? 0n,
    model: r.model,
    outputTokens: r.output_tokens ?? 0n,
  }));
}

export async function listDistinctRepos(userId: string): Promise<string[]> {
  const prisma = getPrisma();

  const sessions = await prisma.session.findMany({
    distinct: ['repoId'],
    include: { repo: { select: { githubName: true, githubOwner: true } } },
    where: { repoId: { not: null }, userId },
  });

  return sessions
    .filter((s) => s.repo !== null)
    .map((s) => `${s.repo?.githubOwner}/${s.repo?.githubName}`)
    .sort();
}
