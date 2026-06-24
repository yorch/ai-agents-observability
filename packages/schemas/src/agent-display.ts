// Human-readable agent labels, driven by agent_type rather than hard-coded
// "Claude" strings (P8-005, DESIGN_DOC §2.4 — "My Agents" is plural by design).
//
// agent_type is the uppercase, underscored value shared by the wire/event schema
// and the Prisma/DB enum ('CLAUDE_CODE'). The key is normalized defensively so any
// casing or hyphenation (legacy 'claude-code') resolves to the same label.

const CANONICAL: Record<string, string> = {
  AIDER: 'Aider',
  CLAUDE_CODE: 'Claude Code',
  CODEX: 'Codex',
  COPILOT: 'Copilot',
  CURSOR: 'Cursor',
  OPENCODE: 'opencode',
  WINDSURF: 'Windsurf',
};

/** The default agent for single-agent deployments. */
export const DEFAULT_AGENT_TYPE = 'CLAUDE_CODE';

function normalizeKey(agentType: string): string {
  return agentType.replaceAll('-', '_').toUpperCase();
}

export function agentDisplayName(agentType: string): string {
  return CANONICAL[normalizeKey(agentType)] ?? agentType;
}

/**
 * Distinct display names for a set of agent types, sorted. Returns null when the
 * set is empty or contains only the default agent — callers use that to keep
 * single-agent (CLAUDE_CODE-only) surfaces visually unchanged.
 */
export function multiAgentLabels(agentTypes: string[]): string[] | null {
  const keys = new Set(agentTypes.map(normalizeKey));
  if (keys.size === 0) {
    return null;
  }
  if (keys.size === 1 && keys.has(DEFAULT_AGENT_TYPE)) {
    return null;
  }
  return [...keys].map(agentDisplayName).sort();
}
