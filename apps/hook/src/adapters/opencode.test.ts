import { describe, expect, it } from 'bun:test';

import { selectAdapter } from '.';
import { conformanceErrors } from './conformance';
import { opencodeAdapter } from './opencode';

// Realistic opencode session id: `ses_`-prefixed, NOT a UUID (see P12-002).
const SESSION_ID = 'ses_7bQx19aMfTk3';

describe('opencode adapter', () => {
  it('is selectable by --agent opencode and falls back to claude-code otherwise', () => {
    expect(selectAdapter('opencode')).toBe(opencodeAdapter);
    expect(selectAdapter('claude-code').agentType).toBe('CLAUDE_CODE');
    expect(selectAdapter(undefined).agentType).toBe('CLAUDE_CODE');
    expect(selectAdapter('nonsense').agentType).toBe('CLAUDE_CODE');
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
      sessionID: SESSION_ID,
      tool: 'bash',
    });
    expect(ev.agent_type).toBe('OPENCODE');
    expect(ev.event_type).toBe('PostToolUse');
    expect(ev.tool?.name).toBe('bash');
    expect(ev.tool?.input_bytes).toBeGreaterThan(0);
    expect(ev.session_context.cwd).toBe('/home/dev/proj');
  });

  it('attaches an llm block (with model) so ingest can price via the opencode table', () => {
    const ev = opencodeAdapter.mapPayload('session-idle', {
      model: 'claude-sonnet-4-5-20250929',
      sessionID: SESSION_ID,
      tokens: { input: 1000, output: 200 },
    });
    expect(ev.event_type).toBe('Stop');
    expect(ev.llm?.model).toBe('claude-sonnet-4-5-20250929');
    expect(ev.llm?.input_tokens).toBe(1000);
    expect(ev.llm?.output_tokens).toBe(200);
  });

  // The regression test for P12-002: before normalization, a real `ses_` id failed
  // EventSchema and ingest discarded the event.
  it('emits an EventSchema-conformant event from a real ses_-prefixed session id', () => {
    const ev = opencodeAdapter.mapPayload('post-tool-use', {
      args: { filePath: '/tmp/x' },
      directory: '/home/dev/proj',
      sessionID: SESSION_ID,
      tool: 'read',
    });
    expect(conformanceErrors(ev)).toEqual([]);
    expect(ev.session_id).not.toBe(SESSION_ID);
  });

  it('keeps every event of one session under the same session_id', () => {
    const start = opencodeAdapter.mapPayload('session-start', { sessionID: SESSION_ID });
    const stop = opencodeAdapter.mapPayload('session-idle', { sessionID: SESSION_ID });
    expect(start.session_id).toBe(stop.session_id);
  });

  it('returns null transcriptTarget (opencode uses directory storage — documented finding)', () => {
    expect(opencodeAdapter.transcriptTarget('session-idle', {})).toBeNull();
  });
});
