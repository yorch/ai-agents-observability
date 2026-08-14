import { describe, expect, it } from 'vitest';

import { agentDisplayName } from './agent-display';
import { ADAPTER_AGENT_TYPES, AGENT_REGISTRY, AGENT_TYPES } from './agent-registry';
import { AgentTypeSchema } from './event';

describe('agent registry', () => {
  it('is the source of the wire enum', () => {
    for (const agentType of AGENT_TYPES) {
      expect(AgentTypeSchema.safeParse(agentType).success).toBe(true);
    }
    expect(AgentTypeSchema.options.length).toBe(AGENT_TYPES.length);
  });

  it('gives every agent a non-empty display label', () => {
    for (const agentType of AGENT_TYPES) {
      expect(agentDisplayName(agentType).length).toBeGreaterThan(0);
    }
  });

  it('carries the agents added in P12', () => {
    expect(AGENT_TYPES).toContain('PI');
    expect(AGENT_TYPES).toContain('OMP');
    expect(AGENT_TYPES).toContain('GEMINI_CLI');
    expect(agentDisplayName('GEMINI_CLI')).toBe('Gemini CLI');
    // Both projects lowercase their own names.
    expect(agentDisplayName('OMP')).toBe('omp');
    expect(agentDisplayName('OPENCODE')).toBe('opencode');
  });

  it('lists adapter agents as a subset of all agents', () => {
    for (const agentType of ADAPTER_AGENT_TYPES) {
      expect(AGENT_REGISTRY[agentType].hasAdapter).toBe(true);
      expect(AGENT_TYPES).toContain(agentType);
    }
    // Agents we accept but do not capture yet stay out of the adapter list.
    expect(ADAPTER_AGENT_TYPES).not.toContain('AIDER');
    expect(ADAPTER_AGENT_TYPES).not.toContain('WINDSURF');
  });

  it('resolves legacy hyphenated and lowercased forms to the same label', () => {
    expect(agentDisplayName('claude-code')).toBe('Claude Code');
    expect(agentDisplayName('gemini_cli')).toBe('Gemini CLI');
    expect(agentDisplayName('unknown-agent')).toBe('unknown-agent');
  });
});
