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
  'ACTIVE',
  'COMPLETED',
  'CRASHED',
  'TIMED_OUT',
  'ABANDONED',
]);

const MAX_PAGE = 10_000;

export type FrictionBand = 'low' | 'medium' | 'high';

// Maps a friction band to a frictionScore range predicate. Bands per P7-003:
// Low < 0.3, Medium 0.3–0.6, High > 0.6. Range comparisons on a nullable column
// never match NULL, so insufficient-data sessions are excluded from every band.
export function frictionBandWhere(band: FrictionBand): Prisma.FloatNullableFilter {
  if (band === 'low') {
    return { lt: 0.3 };
  }
  if (band === 'high') {
    return { gt: 0.6 };
  }
  return { gte: 0.3, lte: 0.6 };
}

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
    agentTypes?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    frictionBand?: FrictionBand;
    mode?: string;
    page: number;
    repo?: string;
    shapeLabels?: string[];
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
    ...(opts.shapeLabels?.length ? { shapeLabel: { in: opts.shapeLabels } } : {}),
    ...(opts.agentTypes?.length
      ? { agentType: { in: opts.agentTypes as $Enums.AgentType[] } }
      : {}),
    ...(opts.frictionBand ? { frictionScore: frictionBandWhere(opts.frictionBand) } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
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

export type SessionEvent = {
  eventType: string;
  mcpServer: string | null;
  mcpTool: string | null;
  model: string | null;
  slashCommand: string | null;
  subagentType: string | null;
  toolName: string | null;
  toolWasDenied: boolean | null;
  ts: Date;
};

export async function getSessionEvents(userId: string, sessionId: string): Promise<SessionEvent[]> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<
    {
      event_type: string;
      mcp_server: string | null;
      mcp_tool: string | null;
      model: string | null;
      slash_command: string | null;
      subagent_type: string | null;
      tool_name: string | null;
      tool_was_denied: boolean | null;
      ts: Date;
    }[]
  >(Prisma.sql`
    SELECT ts,
           event_type,
           tool_name,
           tool_was_denied,
           mcp_server,
           mcp_tool,
           slash_command,
           subagent_type,
           model
    FROM events
    WHERE session_id = ${sessionId}::uuid
      AND user_id = ${userId}::uuid
    ORDER BY ts ASC
    LIMIT 500
  `);

  return rows.map((r) => ({
    eventType: r.event_type,
    mcpServer: r.mcp_server,
    mcpTool: r.mcp_tool,
    model: r.model,
    slashCommand: r.slash_command,
    subagentType: r.subagent_type,
    toolName: r.tool_name,
    toolWasDenied: r.tool_was_denied,
    ts: r.ts,
  }));
}

export type SessionToolRow = {
  avgDurationMs: number | null;
  callCount: number;
  deniedCount: number;
  errorCount: number;
  toolCategory: string | null;
  toolName: string;
};

export type SessionSubagentRow = {
  subagentType: string;
  useCount: number;
};

export async function getSessionToolBreakdown(
  userId: string,
  sessionId: string,
): Promise<{ subagents: SessionSubagentRow[]; tools: SessionToolRow[] }> {
  const prisma = getPrisma();
  const [toolRows, subagentRows] = await Promise.all([
    prisma.$queryRaw<
      {
        avg_duration_ms: string | null;
        call_count: bigint;
        denied_count: bigint;
        error_count: bigint;
        tool_category: string | null;
        tool_name: string;
      }[]
    >(Prisma.sql`
      SELECT
        tool_name,
        tool_category,
        COUNT(*)                                              AS call_count,
        COUNT(*) FILTER (WHERE tool_exit_status IS NOT NULL
                           AND tool_exit_status != 0)        AS error_count,
        COUNT(*) FILTER (WHERE tool_was_denied = true)       AS denied_count,
        AVG(tool_duration_ms)::text                          AS avg_duration_ms
      FROM events
      WHERE session_id = ${sessionId}::uuid
        AND user_id   = ${userId}::uuid
        AND tool_name IS NOT NULL
      GROUP BY tool_name, tool_category
      ORDER BY call_count DESC
    `),
    prisma.$queryRaw<{ subagent_type: string; use_count: bigint }[]>(Prisma.sql`
      SELECT subagent_type, COUNT(*) AS use_count
      FROM events
      WHERE session_id  = ${sessionId}::uuid
        AND user_id    = ${userId}::uuid
        AND subagent_type IS NOT NULL
      GROUP BY subagent_type
      ORDER BY use_count DESC
    `),
  ]);

  return {
    subagents: subagentRows.map((r) => ({
      subagentType: r.subagent_type,
      useCount: Number(r.use_count),
    })),
    tools: toolRows.map((r) => ({
      avgDurationMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
      callCount: Number(r.call_count),
      deniedCount: Number(r.denied_count),
      errorCount: Number(r.error_count),
      toolCategory: r.tool_category,
      toolName: r.tool_name,
    })),
  };
}

export type SessionSkillRow = {
  skillName: string;
  skillPath: string | null;
  slashCommand: string | null;
  useCount: number;
};

export async function getSessionSkills(
  userId: string,
  sessionId: string,
): Promise<SessionSkillRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<
    {
      skill_name: string;
      skill_path: string | null;
      slash_command: string | null;
      use_count: bigint;
    }[]
  >(Prisma.sql`
    SELECT skill_name, skill_path, slash_command, COUNT(*) AS use_count
    FROM events
    WHERE session_id = ${sessionId}::uuid
      AND user_id   = ${userId}::uuid
      AND skill_name IS NOT NULL
    GROUP BY skill_name, skill_path, slash_command
    ORDER BY use_count DESC
  `);
  return rows.map((r) => ({
    skillName: r.skill_name,
    skillPath: r.skill_path,
    slashCommand: r.slash_command,
    useCount: Number(r.use_count),
  }));
}

export type SessionOrgContext = {
  displayName: string | null;
  ownerLogin: string | null;
  ownerUserId: string;
  shareTranscriptsWithOrg: boolean;
  transcriptS3Key: string | null;
};

/**
 * Resolves the owner, org-transcript-sharing policy, and transcript pointer for a
 * session, WITHOUT scoping to the caller. For org-admin drill-in only — callers
 * MUST gate with `requireOrgAdmin()` and write an audit row before using the
 * result. Returns null if the session does not exist.
 */
export async function getSessionOrgContext(sessionId: string): Promise<SessionOrgContext | null> {
  const s = await getPrisma().session.findUnique({
    select: {
      transcriptS3Key: true,
      user: {
        select: {
          displayName: true,
          githubLogin: true,
          visibilityPolicy: { select: { shareTranscriptsWithOrg: true } },
        },
      },
      userId: true,
    },
    where: { sessionId },
  });
  if (!s) {
    return null;
  }
  return {
    displayName: s.user.displayName,
    ownerLogin: s.user.githubLogin,
    ownerUserId: s.userId,
    // Conservative default: if no policy row exists, transcripts are NOT org-shared.
    shareTranscriptsWithOrg: s.user.visibilityPolicy?.shareTranscriptsWithOrg ?? false,
    transcriptS3Key: s.transcriptS3Key,
  };
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
