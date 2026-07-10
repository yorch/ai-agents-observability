import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

// Security & compliance queries (org scope). These surface the AI-agent data-flow
// signals the platform already captures but never displayed: which powerful tool
// categories ran and where, which external services (MCP servers) were reached,
// and unusually large data movements. Every event-derived query is visibility-
// scoped exactly like the other org aggregates (only users who share metadata
// with the org contribute; conservative default true when no policy row exists),
// so the security surface never leaks an opted-out developer's activity.

const ORG_VISIBLE = Prisma.sql`
  JOIN users u ON u.id = e.user_id AND u.deactivated_at IS NULL
  LEFT JOIN visibility_policies vp ON vp.user_id = u.id
`;
const ORG_VISIBLE_FILTER = Prisma.sql`COALESCE(vp.share_metadata_with_org, true) = true`;

// Tool categories that represent real exposure surface: code execution, network
// egress, filesystem writes, and MCP calls. fs_read/search are lower-risk and
// tracked but not flagged.
export type CategoryExposureRow = {
  category: string;
  distinctRepos: number;
  distinctUsers: number;
  totalCalls: number;
};

export async function getCategoryExposure(since: Date): Promise<CategoryExposureRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      category: string | null;
      distinct_repos: bigint;
      distinct_users: bigint;
      total_calls: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      e.tool_category                              AS category,
      COUNT(*)                                     AS total_calls,
      COUNT(DISTINCT e.user_id)                    AS distinct_users,
      COUNT(DISTINCT s.repo_id)                    AS distinct_repos
    FROM events e
    ${ORG_VISIBLE}
    JOIN sessions s ON s.session_id = e.session_id
    WHERE e.ts >= ${since}
      AND e.tool_category IS NOT NULL
      AND e.event_type = 'PostToolUse'
      AND ${ORG_VISIBLE_FILTER}
    GROUP BY e.tool_category
    ORDER BY total_calls DESC
  `);
  return rows.map((r) => ({
    category: r.category ?? 'other',
    distinctRepos: Number(r.distinct_repos),
    distinctUsers: Number(r.distinct_users),
    totalCalls: Number(r.total_calls),
  }));
}

// Per-repo breakdown of the highest-risk categories (exec + web). A repo with
// heavy code-execution or network egress is where an AI data-exposure review
// should start.
export type RepoExposureRow = {
  execCalls: number;
  repoName: string;
  webCalls: number;
  writeCalls: number;
};

export async function getRepoExposure(since: Date, limit = 15): Promise<RepoExposureRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      exec_calls: bigint;
      repo_name: string | null;
      web_calls: bigint;
      write_calls: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      CASE WHEN r.github_owner IS NOT NULL
           THEN r.github_owner || '/' || r.github_name END        AS repo_name,
      COUNT(*) FILTER (WHERE e.tool_category = 'exec')            AS exec_calls,
      COUNT(*) FILTER (WHERE e.tool_category = 'web')             AS web_calls,
      COUNT(*) FILTER (WHERE e.tool_category = 'fs_write')        AS write_calls
    FROM events e
    ${ORG_VISIBLE}
    JOIN sessions s ON s.session_id = e.session_id
    JOIN repos r    ON r.id = s.repo_id
    WHERE e.ts >= ${since}
      AND e.event_type = 'PostToolUse'
      AND e.tool_category IN ('exec', 'web', 'fs_write')
      AND ${ORG_VISIBLE_FILTER}
    GROUP BY r.github_owner, r.github_name
    HAVING COUNT(*) FILTER (WHERE e.tool_category IN ('exec', 'web')) > 0
    ORDER BY (COUNT(*) FILTER (WHERE e.tool_category = 'exec')
              + COUNT(*) FILTER (WHERE e.tool_category = 'web')) DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    execCalls: Number(r.exec_calls),
    repoName: r.repo_name ?? 'unknown',
    webCalls: Number(r.web_calls),
    writeCalls: Number(r.write_calls),
  }));
}

// External egress map: every MCP server is a distinct external service the agent
// reached on behalf of a developer — a data-egress point worth an inventory for
// security review. Spread across users/repos shows blast radius.
export type EgressServerRow = {
  distinctRepos: number;
  distinctUsers: number;
  server: string;
  totalCalls: number;
  totalOutputBytes: number;
};

export async function getEgressServers(since: Date): Promise<EgressServerRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      distinct_repos: bigint;
      distinct_users: bigint;
      server: string;
      total_calls: bigint;
      total_output_bytes: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      e.mcp_server                                 AS server,
      COUNT(*)                                     AS total_calls,
      COUNT(DISTINCT e.user_id)                    AS distinct_users,
      COUNT(DISTINCT s.repo_id)                    AS distinct_repos,
      COALESCE(SUM(e.tool_output_bytes), 0)::text  AS total_output_bytes
    FROM events e
    ${ORG_VISIBLE}
    JOIN sessions s ON s.session_id = e.session_id
    WHERE e.ts >= ${since}
      AND e.mcp_server IS NOT NULL
      AND ${ORG_VISIBLE_FILTER}
    GROUP BY e.mcp_server
    ORDER BY total_calls DESC
    LIMIT 100
  `);
  return rows.map((r) => ({
    distinctRepos: Number(r.distinct_repos),
    distinctUsers: Number(r.distinct_users),
    server: r.server,
    totalCalls: Number(r.total_calls),
    totalOutputBytes: Number(r.total_output_bytes ?? 0),
  }));
}

// Large data-movement anomalies: the biggest single tool outputs on network /
// MCP / file-read categories. Outsized reads on `web`/`mcp` in a session are the
// data-exfiltration-shaped signal §3.7 calls out — not proof of anything, but the
// rows a reviewer should look at first. Hashes/sizes only; no content is stored.
export type LargeOutputRow = {
  category: string | null;
  outputBytes: number;
  repoName: string | null;
  sessionId: string;
  toolName: string | null;
  ts: Date;
};

export async function getLargeOutputEvents(since: Date, limit = 20): Promise<LargeOutputRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      output_bytes: number | null;
      repo_name: string | null;
      session_id: string;
      tool_category: string | null;
      tool_name: string | null;
      ts: Date;
    }[]
  >(Prisma.sql`
    SELECT
      e.session_id::text                                          AS session_id,
      e.tool_name                                                 AS tool_name,
      e.tool_category                                             AS tool_category,
      e.tool_output_bytes                                         AS output_bytes,
      e.ts                                                        AS ts,
      CASE WHEN r.github_owner IS NOT NULL
           THEN r.github_owner || '/' || r.github_name END        AS repo_name
    FROM events e
    ${ORG_VISIBLE}
    JOIN sessions s   ON s.session_id = e.session_id
    LEFT JOIN repos r ON r.id = s.repo_id
    WHERE e.ts >= ${since}
      AND e.tool_output_bytes IS NOT NULL
      AND e.tool_category IN ('web', 'mcp', 'fs_read')
      AND ${ORG_VISIBLE_FILTER}
    ORDER BY e.tool_output_bytes DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    category: r.tool_category,
    outputBytes: Number(r.output_bytes ?? 0),
    repoName: r.repo_name,
    sessionId: r.session_id,
    toolName: r.tool_name,
    ts: r.ts,
  }));
}
