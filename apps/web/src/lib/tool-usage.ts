// Tool-name disambiguation across agents (DESIGN_DOC §2.4, P8-001).
//
// Tool names are stored raw in `events` and disambiguated by (agent_type, tool_name)
// at query time. Tool aggregate queries therefore GROUP BY agent_type as well as
// tool_name and feed the rows through `labelToolRows`, which prefixes the agent
// ONLY when the result set spans more than one agent. Single-agent deployments
// (the norm today) see no change to displayed tool names.

export type ToolUsageRow = { callCount: number; toolName: string };

type RawToolRow = { agent_type: string; call_count: bigint; tool_name: string };

export function labelToolRows(rows: RawToolRow[]): ToolUsageRow[] {
  const multiAgent = new Set(rows.map((r) => r.agent_type)).size > 1;
  return rows.map((r) => ({
    callCount: Number(r.call_count),
    toolName: multiAgent ? `${r.agent_type}:${r.tool_name}` : r.tool_name,
  }));
}
