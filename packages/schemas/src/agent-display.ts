// Human-readable agent labels, driven by agent_type rather than hard-coded
// "Claude" strings (P8-005, DESIGN_DOC §2.4 — "My Agents" is plural by design).
//
// Accepts either spelling of the key: the wire/event enum uses hyphens
// ('claude-code') while the Prisma/DB enum uses underscores ('claude_code'),
// so both normalize to the same label.

const CANONICAL: Record<string, string> = {
  aider: 'Aider',
  claude_code: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
  cursor: 'Cursor',
  opencode: 'opencode',
  windsurf: 'Windsurf',
};

/** The default agent for single-agent deployments. */
export const DEFAULT_AGENT_TYPE = 'claude_code';

export function agentDisplayName(agentType: string): string {
  const key = agentType.replaceAll('-', '_');
  return CANONICAL[key] ?? agentType;
}

/**
 * Distinct display names for a set of agent types, sorted. Returns null when the
 * set is empty or contains only the default agent — callers use that to keep
 * single-agent (claude_code-only) surfaces visually unchanged.
 */
export function multiAgentLabels(agentTypes: string[]): string[] | null {
  const keys = new Set(agentTypes.map((a) => a.replaceAll('-', '_')));
  if (keys.size === 0) {
    return null;
  }
  if (keys.size === 1 && keys.has(DEFAULT_AGENT_TYPE)) {
    return null;
  }
  return [...keys].map(agentDisplayName).sort();
}
