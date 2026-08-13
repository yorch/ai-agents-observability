import { describe, expect, it } from 'bun:test';

import { claudeCodeAdapter, toEvent } from './claude-code';
import { conformanceErrors } from './conformance';
import { createStdinHookAdapter } from './stdin-hook-factory';

const SESSION_ID = '3f8c2a1e-9d47-4b6a-8c25-1e7f0a9b4d63';

/** Everything that is not stable across runs/machines. */
function stable(event: Record<string, unknown>): Record<string, unknown> {
  const { client: _c, event_id: _e, ts: _t, user_id_claim: _u, ...rest } = event;
  return rest;
}

// GOLDEN OUTPUT (P12-003). These fixtures were captured by running the same
// payloads through the pre-factory implementation (git HEAD's lib/payload.ts) and
// the factory side by side; they were byte-identical across ten payloads covering
// every hook kind. Encoded here so a future factory change cannot silently alter
// Claude Code's long-standing mapping.
describe('claude-code through the factory — golden output', () => {
  it('maps an MCP tool call identically to the pre-factory implementation', () => {
    const ev = toEvent('post-tool-use', {
      cwd: '/repo',
      extra_field: 'kept',
      session_id: SESSION_ID,
      tool_input: { a: 1 },
      tool_name: 'mcp__github__list_issues',
      tool_response: 'ok',
    });
    expect(stable(ev)).toEqual({
      agent_type: 'CLAUDE_CODE',
      event_type: 'PostToolUse',
      // Unmodelled payload keys still ride along verbatim.
      metadata: { extra_field: 'kept' },
      redaction_flags: [],
      schema_version: 1,
      session_context: { cwd: '/repo', git: null, is_resume: false, mode: 'normal' },
      session_id: SESSION_ID,
      tool: {
        category: 'mcp',
        duration_ms: 0,
        exit_status: null,
        input_bytes: 7,
        input_hash: null,
        mcp_server: 'github',
        mcp_tool: 'list_issues',
        name: 'mcp__github__list_issues',
        output_bytes: 2,
        skill: null,
        slash_command: null,
        subagent_type: null,
        was_denied: false,
        was_interrupted: false,
      },
    });
  });

  it('keeps Claude-specific tool semantics (Task → subagent_type)', () => {
    const ev = toEvent('pre-tool-use', {
      cwd: '/repo',
      session_id: SESSION_ID,
      tool_input: { subagent_type: 'Explore' },
      tool_name: 'Task',
    });
    expect(ev.tool?.subagent_type).toBe('Explore');
    expect(ev.tool?.category).toBe('builtin');
  });

  it('keeps Claude-specific metadata enrichment (slash command, notification kind)', () => {
    const prompt = toEvent('user-prompt-submit', {
      cwd: '/repo',
      prompt: '  /deep-research find things',
      session_id: SESSION_ID,
    });
    expect(prompt.metadata).toEqual({ slash_command: 'deep-research' });

    const note = toEvent('notification', {
      cwd: '/repo',
      message: 'needs permission',
      notification_type: 'permission_request',
      session_id: SESSION_ID,
    });
    expect(note.metadata).toEqual({
      message: 'needs permission',
      notification_kind: 'permission',
      notification_type: 'permission_request',
    });
  });

  it('does not leak `model` out of metadata for Claude (its known-key set is explicit)', () => {
    const ev = toEvent('stop', { cwd: '/repo', model: 'claude-opus-4', session_id: SESSION_ID });
    expect(ev.metadata.model).toBe('claude-opus-4');
  });

  it('ships the Stop transcript keyed to the event session id', () => {
    const raw = { session_id: SESSION_ID, transcript_path: '/home/d/.claude/t.jsonl' };
    expect(claudeCodeAdapter.transcriptTarget('stop', raw)).toEqual({
      sessionId: SESSION_ID,
      transcriptPath: '/home/d/.claude/t.jsonl',
    });
    expect(claudeCodeAdapter.transcriptTarget('pre-tool-use', raw)).toBeNull();
  });
});

describe('createStdinHookAdapter', () => {
  const adapter = createStdinHookAdapter({
    agentType: 'GEMINI_CLI',
    eventMap: { 'after-tool': 'PostToolUse', 'session-start': 'SessionStart' },
    fields: { sessionId: ['sessionId', 'session_id'], toolInput: ['toolArgs', 'tool_input'] },
    install: {
      agentName: 'Test Agent',
      renderSnippet: () => 'snippet',
      settingsHint: 'hint',
    },
    transcriptKinds: ['after-tool'],
  });

  it('recognizes exactly the kinds in its event map', () => {
    expect(adapter.isHookKind('after-tool')).toBe(true);
    expect(adapter.isHookKind('nope')).toBe(false);
    expect(adapter.installConfig().hookKinds).toEqual(['after-tool', 'session-start']);
  });

  it('reads either spelling of an aliased field', () => {
    const camel = adapter.mapPayload('after-tool', {
      cwd: '/r',
      sessionId: 'abc-123',
      tool_name: 'read',
      toolArgs: { x: 1 },
    });
    const snake = adapter.mapPayload('after-tool', {
      cwd: '/r',
      session_id: 'abc-123',
      tool_input: { x: 1 },
      tool_name: 'read',
    });
    expect(camel.session_id).toBe(snake.session_id);
    expect(camel.tool?.input_bytes).toBe(snake.tool?.input_bytes);
    expect(camel.tool?.input_bytes).toBeGreaterThan(0);
  });

  it('normalizes a non-UUID session id into a conformant event', () => {
    const ev = adapter.mapPayload('session-start', { cwd: '/r', sessionId: 'not-a-uuid' });
    expect(conformanceErrors(ev)).toEqual([]);
    expect(ev.agent_type).toBe('GEMINI_CLI');
  });

  it('falls back to Notification for an unmapped kind rather than inventing a type', () => {
    const ev = adapter.mapPayload('unknown-kind', { sessionId: 'abc' });
    expect(ev.event_type).toBe('Notification');
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('ships a transcript only for declared kinds, and only with both path and id', () => {
    const raw = { sessionId: 'abc-123', transcript_path: '/tmp/t.jsonl' };
    expect(adapter.transcriptTarget('after-tool', raw)?.transcriptPath).toBe('/tmp/t.jsonl');
    expect(adapter.transcriptTarget('session-start', raw)).toBeNull();
    expect(adapter.transcriptTarget('after-tool', { sessionId: 'abc-123' })).toBeNull();
  });
});
