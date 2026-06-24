import { describe, expect, it } from 'bun:test';

import { selectAdapter } from '../src/adapters';
import { opencodeAdapter } from '../src/adapters/opencode';

describe('opencode adapter', () => {
  it('is selectable by --agent opencode and falls back to claude-code otherwise', () => {
    expect(selectAdapter('opencode')).toBe(opencodeAdapter);
    expect(selectAdapter('claude-code').agentType).toBe('claude-code');
    expect(selectAdapter(undefined).agentType).toBe('claude-code');
    expect(selectAdapter('nonsense').agentType).toBe('claude-code');
  });

  it('recognizes opencode hook kinds', () => {
    expect(opencodeAdapter.isHookKind('pre-tool-use')).toBe(true);
    expect(opencodeAdapter.isHookKind('session-idle')).toBe(true);
    expect(opencodeAdapter.isHookKind('not-a-kind')).toBe(false);
  });

  it('maps a tool event to a PostToolUse with agent_type=opencode and a tool block', () => {
    const ev = opencodeAdapter.mapPayload('post-tool-use', {
      args: { command: 'ls' },
      directory: '/home/dev/proj',
      result: 'a\nb\n',
      sessionID: '01906a44-0000-7000-8000-000000000000',
      tool: 'bash',
    });
    expect(ev.agent_type).toBe('opencode');
    expect(ev.event_type).toBe('PostToolUse');
    expect(ev.tool?.name).toBe('bash');
    expect(ev.tool?.input_bytes).toBeGreaterThan(0);
    expect(ev.session_context.cwd).toBe('/home/dev/proj');
  });

  it('attaches an llm block (with model) so ingest can price via the opencode table', () => {
    const ev = opencodeAdapter.mapPayload('session-idle', {
      model: 'claude-sonnet-4-5-20250929',
      sessionID: '01906a44-0000-7000-8000-000000000000',
      tokens: { input: 1000, output: 200 },
    });
    expect(ev.event_type).toBe('Stop');
    expect(ev.llm?.model).toBe('claude-sonnet-4-5-20250929');
    expect(ev.llm?.input_tokens).toBe(1000);
    expect(ev.llm?.output_tokens).toBe(200);
  });

  it('returns null transcriptTarget (opencode uses directory storage — documented finding)', () => {
    expect(opencodeAdapter.transcriptTarget('session-idle', {})).toBeNull();
  });
});
