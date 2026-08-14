// Human-readable agent labels, driven by agent_type rather than hard-coded
// "Claude" strings (P8-005, DESIGN_DOC §2.4 — "My Agents" is plural by design).
//
// agent_type is the uppercase, underscored value shared by the wire/event schema
// and the Prisma/DB enum ('CLAUDE_CODE'). The key is normalized defensively so any
// casing or hyphenation (legacy 'claude-code') resolves to the same label.
//
// The labels themselves live in `agent-registry.ts` (P12-001) so the enum, the
// labels, and the adapter list cannot drift apart.

import { AGENT_REGISTRY } from './agent-registry';

/** The default agent for single-agent deployments. */
export const DEFAULT_AGENT_TYPE = 'CLAUDE_CODE';

function normalizeKey(agentType: string): string {
  return agentType.replaceAll('-', '_').toUpperCase();
}

export function agentDisplayName(agentType: string): string {
  const key = normalizeKey(agentType);
  return key in AGENT_REGISTRY
    ? AGENT_REGISTRY[key as keyof typeof AGENT_REGISTRY].label
    : agentType;
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
