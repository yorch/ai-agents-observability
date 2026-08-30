import { describe, expect, it } from 'bun:test';

import { selectAdapter } from '.';
import { conformanceErrors } from './conformance';
import { copilotAdapter } from './copilot';

// Copilot's `sessionId` format is unspecified, so the adapter must not assume it
// is a UUID (P12-002).
const SESSION_ID = 'copilot-sess-01J9ZQ8';

describe('copilot adapter', () => {
  it('is selectable by --agent copilot', () => {
    expect(selectAdapter('copilot')).toBe(copilotAdapter);
    expect(selectAdapter('COPILOT')).toBe(copilotAdapter);
  });

  it('maps copilot event names onto canonical types', () => {
    const cases: [string, string][] = [
      ['session-start', 'SessionStart'],
      ['user-prompt-submitted', 'UserPromptSubmit'],
      ['pre-tool-use', 'PreToolUse'],
      ['post-tool-use', 'PostToolUse'],
      ['agent-stop', 'Stop'],
      ['pre-compact', 'PreCompact'],
      ['subagent-stop', 'SubagentStop'],
      ['session-end', 'SessionEnd'],
    ];
    for (const [kind, expected] of cases) {
      const ev = copilotAdapter.mapPayload(kind, { sessionId: SESSION_ID, toolName: 'bash' });
      expect(ev.event_type).toBe(expected as never);
      expect(ev.agent_type).toBe('COPILOT');
      expect(conformanceErrors(ev)).toEqual([]);
    }
  });

  it('drops events with no canonical equivalent rather than inventing a type', () => {
    expect(copilotAdapter.isHookKind('error-occurred')).toBe(false);
    expect(copilotAdapter.isHookKind('user-prompt-transformed')).toBe(false);
    expect(copilotAdapter.isHookKind('permission-request')).toBe(false);
    expect(copilotAdapter.isHookKind('subagent-start')).toBe(false);
  });

  it('reads camelCase and snake_case payloads identically', () => {
    const camel = copilotAdapter.mapPayload('post-tool-use', {
      cwd: '/repo',
      sessionId: SESSION_ID,
      timestamp: 1786584009539,
      toolArgs: { command: 'ls -la' },
      toolName: 'bash',
      toolResult: 'a\nb\n',
    });
    const pascal = copilotAdapter.mapPayload('post-tool-use', {
      cwd: '/repo',
      session_id: SESSION_ID,
      timestamp: '2026-08-13T01:00:09.539Z',
      tool_input: { command: 'ls -la' },
      tool_name: 'bash',
      tool_response: 'a\nb\n',
    });
    expect(camel.session_id).toBe(pascal.session_id);
    expect(camel.tool?.name).toBe(pascal.tool?.name);
    expect(camel.tool?.input_bytes).toBe(pascal.tool?.input_bytes);
    expect(camel.tool?.output_bytes).toBe(pascal.tool?.output_bytes);
    expect(camel.session_context.cwd).toBe('/repo');
  });

  it('keeps both timestamp encodings in metadata without misparsing either', () => {
    const numeric = copilotAdapter.mapPayload('session-start', {
      sessionId: SESSION_ID,
      timestamp: 1786584009539,
    });
    const iso = copilotAdapter.mapPayload('session-start', {
      sessionId: SESSION_ID,
      timestamp: '2026-08-13T01:00:09.539Z',
    });
    expect(numeric.metadata.timestamp).toBe(1786584009539);
    expect(iso.metadata.timestamp).toBe('2026-08-13T01:00:09.539Z');
    // `ts` is stamped locally either way, so both are valid events.
    expect(conformanceErrors(numeric)).toEqual([]);
    expect(conformanceErrors(iso)).toEqual([]);
  });

  it('folds postToolUseFailure into PostToolUse with a non-zero exit_status', () => {
    const ev = copilotAdapter.mapPayload('post-tool-use-failure', {
      error: 'command not found',
      hook_event_name: 'postToolUseFailure',
      sessionId: SESSION_ID,
      toolName: 'bash',
    });
    expect(ev.event_type).toBe('PostToolUse');
    expect(ev.tool?.exit_status).toBe(1);
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('flags a failure from the KIND alone, with no corroborating payload field', () => {
    // A failure payload need not restate hook_event_name, and its error can be
    // nested. Sniffing the payload alone recorded these as successes — an agent
    // whose every tool call fails would have reported a 0% error rate.
    const bare = copilotAdapter.mapPayload('post-tool-use-failure', {
      sessionId: SESSION_ID,
      toolName: 'bash',
    });
    expect(bare.tool?.exit_status).toBe(1);

    const nested = copilotAdapter.mapPayload('post-tool-use-failure', {
      sessionId: SESSION_ID,
      toolName: 'bash',
      toolResult: { error: 'boom' },
    });
    expect(nested.tool?.exit_status).toBe(1);
  });

  it('does not invent a failure from a present-but-empty error field', () => {
    // Payloads that always carry `error`, set falsy on success, are a common
    // shape; treating mere presence as failure marks every call failed.
    for (const error of [false, '', null]) {
      const ev = copilotAdapter.mapPayload('post-tool-use', {
        error,
        sessionId: SESSION_ID,
        toolName: 'bash',
        toolResult: 'ok',
      });
      expect({ error, exit: ev.tool?.exit_status }).toEqual({ error, exit: null });
    }
  });

  it('keeps a successful call clean', () => {
    const ev = copilotAdapter.mapPayload('post-tool-use', {
      sessionId: SESSION_ID,
      toolName: 'bash',
      toolResult: 'a\nb\n',
    });
    expect(ev.tool?.exit_status).toBeNull();
  });

  // P14-010: Copilot's postToolUse payload (docs.github.com/en/copilot/reference/
  // hooks-reference, checked live) documents no duration field — null, never 0.
  it('leaves duration_ms null — Copilot documents no timing field on postToolUse', () => {
    const ev = copilotAdapter.mapPayload('post-tool-use', {
      sessionId: SESSION_ID,
      toolName: 'bash',
      toolResult: 'a\nb\n',
    });
    expect(ev.tool?.duration_ms).toBe(null);
  });

  it('normalizes the non-UUID sessionId consistently across a session', () => {
    const start = copilotAdapter.mapPayload('session-start', { sessionId: SESSION_ID });
    const stop = copilotAdapter.mapPayload('agent-stop', { sessionId: SESSION_ID });
    expect(start.session_id).toBe(stop.session_id);
    expect(start.session_id).not.toBe(SESSION_ID);
    expect(conformanceErrors(start)).toEqual([]);
  });

  it('ships no transcript (a separate decision from usage capture, P14-007)', () => {
    // `agentStop` now documents a `transcriptPath` field (it did not at P12-006),
    // so this asserts the current choice, not an absence of one to wire up: see
    // the P14-007 note in copilot.ts for why shipping it is deliberately deferred.
    expect(
      copilotAdapter.transcriptTarget('agent-stop', {
        sessionId: SESSION_ID,
        transcriptPath: '/home/dev/.copilot/session-state/abc/events.jsonl',
      }),
    ).toBeNull();
  });

  it('never attaches usage — Copilot documents no token/usage field on any hook (P14-007)', () => {
    // Claude Code, Codex and Gemini CLI each fold per-turn usage onto their
    // turn-completion event (P14-003); Copilot has no side channel a hook can
    // reach (see the P14-007 note in copilot.ts). This pins the current, verified
    // absence rather than letting it drift back unnoticed: a payload carrying
    // usage-shaped fields Copilot does not actually send must still produce no
    // `llm` block, because inventing one from an undocumented field would be
    // exactly the fabrication P14-007 stopped short of.
    const ev = copilotAdapter.mapPayload('agent-stop', {
      inputTokens: 123,
      model: 'claude-opus-4.7',
      outputTokens: 45,
      sessionId: SESSION_ID,
      tokens: { input: 123, output: 45 },
      usage: { input_tokens: 123, output_tokens: 45 },
    });
    expect(ev.llm).toBeUndefined();
    expect(copilotAdapter.mapBatch).toBeUndefined();
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('renders a versioned hooks document in cross-platform exec form', () => {
    const bin = '/home/jorge barnaby/.local/bin/aiot';
    const parsed = JSON.parse(copilotAdapter.installConfig().renderSnippet(bin)) as {
      disableAllHooks: boolean;
      hooks: Record<string, { command: string[]; timeoutSec: number; type: string }[]>;
      version: number;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.disableAllHooks).toBe(false);
    expect(Object.keys(parsed.hooks)).toContain('preToolUse');
    expect(Object.keys(parsed.hooks)).toContain('agentStop');
    const entry = parsed.hooks.preToolUse?.[0];
    expect(entry?.type).toBe('command');
    // A path with spaces stays one argv element — Copilot's fail-closed preToolUse
    // makes a mangled command a denied tool call, not just a lost event.
    expect(entry?.command).toEqual([bin, 'hook', 'pre-tool-use', '--agent', 'copilot']);
    expect(entry?.timeoutSec).toBe(5);
  });
});
