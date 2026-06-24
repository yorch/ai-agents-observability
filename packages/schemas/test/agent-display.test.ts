import { describe, expect, it } from 'vitest';
import { agentDisplayName, multiAgentLabels } from '../src/agent-display';

describe('agentDisplayName', () => {
  it('maps known agents, accepting hyphen or underscore spelling', () => {
    expect(agentDisplayName('claude-code')).toBe('Claude Code');
    expect(agentDisplayName('claude_code')).toBe('Claude Code');
    expect(agentDisplayName('opencode')).toBe('opencode');
    expect(agentDisplayName('cursor')).toBe('Cursor');
  });

  it('falls back to the raw value for unknown agents', () => {
    expect(agentDisplayName('some-future-agent')).toBe('some-future-agent');
  });
});

describe('multiAgentLabels', () => {
  it('returns null for the single-default (claude_code) case', () => {
    expect(multiAgentLabels(['claude_code'])).toBeNull();
    expect(multiAgentLabels(['claude-code', 'claude_code'])).toBeNull();
    expect(multiAgentLabels([])).toBeNull();
  });

  it('labels a single non-default agent', () => {
    expect(multiAgentLabels(['opencode'])).toEqual(['opencode']);
  });

  it('returns sorted distinct labels for multiple agents', () => {
    expect(multiAgentLabels(['opencode', 'claude_code', 'opencode'])).toEqual([
      'Claude Code',
      'opencode',
    ]);
  });
});
