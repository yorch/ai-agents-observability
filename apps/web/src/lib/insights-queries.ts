import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type McpUsageRow = {
  avgDurationMs: number | null;
  callCount: number;
  errorCount: number;
  mcpServer: string;
  mcpTool: string | null;
};

export type SkillUsageRow = {
  skillName: string;
  skillPath: string | null;
  useCount: number;
};

export type SlashCommandRow = {
  command: string;
  useCount: number;
};

export type SubagentUsageRow = {
  subagentType: string;
  useCount: number;
};

export type ToolPerfRow = {
  avgDurationMs: number | null;
  callCount: number;
  deniedCount: number;
  errorCount: number;
  p95DurationMs: number | null;
  toolCategory: string | null;
  toolName: string;
};

export async function getMcpUsage(userId: string, since: Date): Promise<McpUsageRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      avg_duration_ms: string | null;
      call_count: bigint;
      error_count: bigint;
      mcp_server: string;
      mcp_tool: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      mcp_server,
      mcp_tool,
      COUNT(*)                                                                AS call_count,
      COUNT(*) FILTER (WHERE tool_exit_status IS NOT NULL
                         AND tool_exit_status != 0)                          AS error_count,
      AVG(tool_duration_ms)::text                                            AS avg_duration_ms
    FROM events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND mcp_server IS NOT NULL
    GROUP BY mcp_server, mcp_tool
    ORDER BY call_count DESC
    LIMIT 100
  `);
  return rows.map((r) => ({
    avgDurationMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
    callCount: Number(r.call_count),
    errorCount: Number(r.error_count),
    mcpServer: r.mcp_server,
    mcpTool: r.mcp_tool,
  }));
}

export async function getSkillUsage(userId: string, since: Date): Promise<SkillUsageRow[]> {
  const rows = await getPrisma().$queryRaw<
    { skill_name: string; skill_path: string | null; use_count: bigint }[]
  >(Prisma.sql`
    SELECT skill_name, skill_path, COUNT(*) AS use_count
    FROM events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND skill_name IS NOT NULL
    GROUP BY skill_name, skill_path
    ORDER BY use_count DESC
    LIMIT 50
  `);
  return rows.map((r) => ({
    skillName: r.skill_name,
    skillPath: r.skill_path,
    useCount: Number(r.use_count),
  }));
}

export async function getSlashCommands(userId: string, since: Date): Promise<SlashCommandRow[]> {
  const rows = await getPrisma().$queryRaw<
    { slash_command: string; use_count: bigint }[]
  >(Prisma.sql`
    SELECT slash_command, COUNT(*) AS use_count
    FROM events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND slash_command IS NOT NULL
    GROUP BY slash_command
    ORDER BY use_count DESC
    LIMIT 50
  `);
  return rows.map((r) => ({
    command: r.slash_command,
    useCount: Number(r.use_count),
  }));
}

export async function getSubagentUsage(userId: string, since: Date): Promise<SubagentUsageRow[]> {
  const rows = await getPrisma().$queryRaw<
    { subagent_type: string; use_count: bigint }[]
  >(Prisma.sql`
    SELECT subagent_type, COUNT(*) AS use_count
    FROM events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND subagent_type IS NOT NULL
    GROUP BY subagent_type
    ORDER BY use_count DESC
  `);
  return rows.map((r) => ({
    subagentType: r.subagent_type,
    useCount: Number(r.use_count),
  }));
}

export async function getToolPerf(userId: string, since: Date): Promise<ToolPerfRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      avg_duration_ms: string | null;
      call_count: bigint;
      denied_count: bigint;
      error_count: bigint;
      p95_duration_ms: string | null;
      tool_category: string | null;
      tool_name: string;
    }[]
  >(Prisma.sql`
    SELECT
      tool_name,
      tool_category,
      COUNT(*)                                                                AS call_count,
      COUNT(*) FILTER (WHERE tool_exit_status IS NOT NULL
                         AND tool_exit_status != 0)                          AS error_count,
      COUNT(*) FILTER (WHERE tool_was_denied = true)                        AS denied_count,
      AVG(tool_duration_ms)::text                                            AS avg_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tool_duration_ms)::text  AS p95_duration_ms
    FROM events
    WHERE user_id = ${userId}::uuid
      AND ts       >= ${since}
      AND event_type = 'PostToolUse'
      AND tool_name  IS NOT NULL
    GROUP BY tool_name, tool_category
    ORDER BY call_count DESC
    LIMIT 25
  `);
  return rows.map((r) => ({
    avgDurationMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
    callCount: Number(r.call_count),
    deniedCount: Number(r.denied_count),
    errorCount: Number(r.error_count),
    p95DurationMs: r.p95_duration_ms != null ? Math.round(Number(r.p95_duration_ms)) : null,
    toolCategory: r.tool_category,
    toolName: r.tool_name,
  }));
}
