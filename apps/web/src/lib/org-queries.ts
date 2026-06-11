import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

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

/** Anomaly detection: cost spikes (>2σ over trailing 14-day baseline) and error spikes. */
export async function getAnomalies(): Promise<AnomalyRow[]> {
  const prisma = getPrisma();
  const anomalies: AnomalyRow[] = [];

  // Cost spike detection: compare last 7 days vs prior 14-day baseline
  const now = new Date();
  const last7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const baselineStart = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);

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

  if (avgCost > 0 && stddev > 0 && currentCost > avgCost + 2 * stddev) {
    anomalies.push({
      kind: 'spend_spike',
      label: 'Spend spike',
      message: `Last 7-day cost ($${currentCost.toFixed(2)}) is more than 2σ above the 14-day baseline ($${avgCost.toFixed(2)} ± $${stddev.toFixed(2)}/day).`,
      severity: currentCost > avgCost + 3 * stddev ? 'critical' : 'warn',
    });
  }

  // High error rate: tool errors > 10% of tool calls in last 7 days
  const errorStats = await prisma.session.aggregate({
    _sum: { toolCallCount: true, toolErrorCount: true },
    where: {
      startedAt: { gte: last7 },
      user: {
        deactivatedAt: null,
        OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
      },
    },
  });

  const totalCalls = Number(errorStats._sum.toolCallCount ?? 0);
  const totalErrors = Number(errorStats._sum.toolErrorCount ?? 0);
  if (totalCalls > 100 && totalErrors / totalCalls > 0.1) {
    anomalies.push({
      kind: 'error_spike',
      label: 'High tool error rate',
      message: `${((totalErrors / totalCalls) * 100).toFixed(1)}% of tool calls failed in the last 7 days (${totalErrors} errors / ${totalCalls} calls).`,
      severity: totalErrors / totalCalls > 0.25 ? 'critical' : 'warn',
    });
  }

  return anomalies;
}

// ── Faceted search ─────────────────────────────────────────────────────────────

export type SessionSearchFilters = {
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  model?: string | undefined;
  page?: number | undefined;
  repoId?: string | undefined;
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
  if (!canViewIndividuals || !query.trim()) {
    return [];
  }

  // Only search transcripts of users who share with org AND opted in to transcript sharing
  const prisma = getPrisma();

  const rows = await prisma.$queryRaw<
    {
      content_text: string;
      github_login: string | null;
      message_idx: number;
      role: string;
      session_id: string;
      ts: Date | null;
    }[]
  >(Prisma.sql`
    SELECT
      ti.session_id::text,
      ti.message_idx,
      ti.role,
      ti.ts,
      ts_headline('english', ti.content_text,
        plainto_tsquery('english', ${query}),
        'MaxWords=40, MinWords=15, ShortWord=3'
      ) AS content_text,
      u.github_login
    FROM transcript_index ti
    JOIN sessions s ON s.session_id = ti.session_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE ti.content_tsv @@ plainto_tsquery('english', ${query})
      AND u.deactivated_at IS NULL
      AND COALESCE(vp.share_transcripts_with_org, false) = true
    ORDER BY ts_rank(ti.content_tsv, plainto_tsquery('english', ${query})) DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    excerpt: r.content_text,
    githubLogin: r.github_login,
    messageIdx: r.message_idx,
    role: r.role,
    sessionId: r.session_id,
    ts: r.ts,
  }));
}
