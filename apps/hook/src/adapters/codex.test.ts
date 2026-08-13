import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectAdapter } from '.';
import { codexAdapter, codexHooksEnabled, resetCodexHooksCache } from './codex';
import { conformanceErrors } from './conformance';

describe('codex adapter — selection & mapping', () => {
  it('is selectable by --agent codex and falls back to claude-code otherwise', () => {
    expect(selectAdapter('codex')).toBe(codexAdapter);
    expect(selectAdapter('codex').agentType).toBe('CODEX');
    expect(selectAdapter(undefined).agentType).toBe('CLAUDE_CODE');
    expect(selectAdapter('nonsense').agentType).toBe('CLAUDE_CODE');
  });

  it('recognizes codex hook kinds', () => {
    expect(codexAdapter.isHookKind('turn-complete')).toBe(true);
    expect(codexAdapter.isHookKind('session-start')).toBe(true);
    expect(codexAdapter.isHookKind('not-a-kind')).toBe(false);
  });

  it('maps turn-complete to a Stop event with agent_type=codex (single-event fallback)', () => {
    const ev = codexAdapter.mapPayload('turn-complete', {
      'last-assistant-message': 'done',
      'session-id': '01906a44-0000-7000-8000-000000000000',
    });
    expect(ev.agent_type).toBe('CODEX');
    expect(ev.event_type).toBe('Stop');
    expect(ev.session_id).toBe('01906a44-0000-7000-8000-000000000000');
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('normalizes a non-UUID conversation id rather than emitting a droppable event', () => {
    const ev = codexAdapter.mapPayload('turn-complete', { 'conversation-id': 'conv_9f2b71' });
    expect(conformanceErrors(ev)).toEqual([]);
    expect(ev.session_id).not.toBe('conv_9f2b71');
  });
});

describe('codex adapter — rollout-backed mapBatch', () => {
  let codexHome: string;
  let telHome: string;
  const sessionId = '0190abcd-1111-7000-8000-000000000001';

  function writeRollout(lines: object[]): string {
    const dir = join(codexHome, 'sessions', '2026', '06', '24');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-06-24T10-00-00-${sessionId}.jsonl`);
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    return path;
  }

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    telHome = mkdtempSync(join(tmpdir(), 'codex-tel-'));
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_TELEMETRY_HOME = telHome;
  });

  afterEach(() => {
    rmSync(codexHome, { force: true, recursive: true });
    rmSync(telHome, { force: true, recursive: true });
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_TELEMETRY_HOME;
  });

  it('expands a turn into per-tool PostToolUse events plus a usage-bearing Stop', () => {
    writeRollout([
      { model: 'gpt-5-codex', type: 'turn_context' },
      { arguments: '{"command":"ls"}', call_id: 'c1', name: 'shell', type: 'function_call' },
      { call_id: 'c1', output: 'a\nb\n', type: 'function_call_output' },
      {
        info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } },
        type: 'token_count',
      },
    ]);

    const events = codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId });
    expect(events).not.toBeNull();
    const evs = events ?? [];
    const tools = evs.filter((e) => e.event_type === 'PostToolUse');
    const stops = evs.filter((e) => e.event_type === 'Stop');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool?.name).toBe('shell');
    expect(tools[0]?.agent_type).toBe('CODEX');
    expect(tools[0]?.session_id).toBe(sessionId);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.llm?.model).toBe('gpt-5-codex');
    expect(stops[0]?.llm?.input_tokens).toBe(1000);
    expect(stops[0]?.llm?.output_tokens).toBe(200);
  });

  it('advances the cursor so a second turn only emits the new turn (delta usage)', () => {
    const path = writeRollout([
      { arguments: '{}', call_id: 'c1', name: 'shell', type: 'function_call' },
      {
        info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } },
        type: 'token_count',
      },
    ]);

    const first = codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId }) ?? [];
    expect(first.filter((e) => e.event_type === 'PostToolUse')).toHaveLength(1);

    // Append a second turn to the same rollout file.
    const appended = [
      { arguments: '{}', call_id: 'c2', name: 'apply_patch', type: 'function_call' },
      {
        info: { total_token_usage: { input_tokens: 1700, output_tokens: 450 } },
        type: 'token_count',
      },
    ];
    writeFileSync(
      path,
      `${[
        { arguments: '{}', call_id: 'c1', name: 'shell', type: 'function_call' },
        {
          info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } },
          type: 'token_count',
        },
        ...appended,
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
      'utf8',
    );

    const second = codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId }) ?? [];
    const tools = second.filter((e) => e.event_type === 'PostToolUse');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool?.name).toBe('apply_patch');
    const stop = second.find((e) => e.event_type === 'Stop');
    // Delta over the prior cumulative total (1700-1000, 450-200).
    expect(stop?.llm?.input_tokens).toBe(700);
    expect(stop?.llm?.output_tokens).toBe(250);
  });

  it('returns the rollout path as the transcript target', () => {
    const path = writeRollout([{ model: 'gpt-5-codex', type: 'turn_context' }]);
    const target = codexAdapter.transcriptTarget('turn-complete', { 'session-id': sessionId });
    expect(target?.transcriptPath).toBe(path);
    expect(target?.sessionId).toBe(sessionId);
  });

  it('returns null from mapBatch when no rollout exists (transport falls back to single Stop)', () => {
    expect(codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId })).toBeNull();
  });
});

// P12-004: Codex's native lifecycle hooks. Per-tool events now arrive directly
// instead of being inferred from the rollout; the rollout read survives only for
// token usage, which the hook payload does not carry.
describe('codex adapter — native lifecycle hooks', () => {
  let codexHome: string;
  let telHome: string;
  const sessionId = '0190abcd-2222-7000-8000-000000000002';

  function rolloutPath(): string {
    const dir = join(codexHome, 'sessions', '2026', '08', '13');
    mkdirSync(dir, { recursive: true });
    return join(dir, `rollout-2026-08-13T10-00-00-${sessionId}.jsonl`);
  }

  function writeRollout(lines: object[]): string {
    const path = rolloutPath();
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    return path;
  }

  function enableHooks(): void {
    writeFileSync(join(codexHome, 'config.toml'), '[features]\nhooks = true\n', 'utf8');
    resetCodexHooksCache();
  }

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-hooks-'));
    telHome = mkdtempSync(join(tmpdir(), 'codex-tel-'));
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_TELEMETRY_HOME = telHome;
    resetCodexHooksCache();
  });

  afterEach(() => {
    rmSync(codexHome, { force: true, recursive: true });
    rmSync(telHome, { force: true, recursive: true });
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_TELEMETRY_HOME;
    resetCodexHooksCache();
  });

  it('recognizes the native hook kinds alongside the notify kind', () => {
    expect(codexAdapter.isHookKind('pre-tool-use')).toBe(true);
    expect(codexAdapter.isHookKind('post-tool-use')).toBe(true);
    expect(codexAdapter.isHookKind('stop')).toBe(true);
    expect(codexAdapter.isHookKind('subagent-stop')).toBe(true);
    expect(codexAdapter.isHookKind('turn-complete')).toBe(true);
    // PostCompact / SubagentStart have no canonical equivalent and stay unmapped.
    expect(codexAdapter.isHookKind('post-compact')).toBe(false);
    expect(codexAdapter.isHookKind('subagent-start')).toBe(false);
  });

  it('maps a PreToolUse hook straight to a tool event — no rollout inference', () => {
    const ev = codexAdapter.mapPayload('pre-tool-use', {
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      model: 'gpt-5-codex',
      session_id: sessionId,
      tool_input: { command: 'ls -la' },
      tool_name: 'shell',
      turn_id: 'turn_42',
    });
    expect(conformanceErrors(ev)).toEqual([]);
    expect(ev.event_type).toBe('PreToolUse');
    expect(ev.agent_type).toBe('CODEX');
    expect(ev.session_id).toBe(sessionId);
    expect(ev.tool?.name).toBe('shell');
    expect(ev.tool?.input_bytes).toBeGreaterThan(0);
    expect(ev.session_context.cwd).toBe('/repo');
    // turn_id is the only turn-scoped correlator Codex gives us — keep it.
    expect(ev.metadata.turn_id).toBe('turn_42');
    expect(ev.metadata.model).toBe('gpt-5-codex');
  });

  it('maps an MCP tool call to mcp_server / mcp_tool', () => {
    const ev = codexAdapter.mapPayload('post-tool-use', {
      session_id: sessionId,
      tool_name: 'mcp__github__list_issues',
      tool_response: 'ok',
    });
    expect(ev.tool?.category).toBe('mcp');
    expect(ev.tool?.mcp_server).toBe('github');
    expect(ev.tool?.mcp_tool).toBe('list_issues');
  });

  it('maps PermissionRequest to a classified Notification, not a new event type', () => {
    const ev = codexAdapter.mapPayload('permission-request', {
      message: 'Codex needs your permission to run shell',
      session_id: sessionId,
      tool_name: 'shell',
    });
    expect(conformanceErrors(ev)).toEqual([]);
    expect(ev.event_type).toBe('Notification');
    expect(ev.metadata.notification_kind).toBe('permission');
  });

  it('attaches rollout usage to the Stop hook (the hook payload carries none)', () => {
    const path = writeRollout([
      { model: 'gpt-5-codex', type: 'turn_context' },
      {
        info: { total_token_usage: { input_tokens: 1200, output_tokens: 340 } },
        type: 'token_count',
      },
    ]);

    const events = codexAdapter.mapBatch?.('stop', {
      cwd: '/repo',
      hook_event_name: 'Stop',
      model: 'gpt-5-codex',
      session_id: sessionId,
      transcript_path: path,
    });
    expect(events).toHaveLength(1);
    const stop = events?.[0];
    expect(stop?.event_type).toBe('Stop');
    expect(stop?.llm?.input_tokens).toBe(1200);
    expect(stop?.llm?.output_tokens).toBe(340);
    expect(stop?.llm?.model).toBe('gpt-5-codex');
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('emits exactly one Stop from the hook — tool calls are not re-expanded', () => {
    const path = writeRollout([
      { arguments: '{}', call_id: 'c1', name: 'shell', type: 'function_call' },
      {
        info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } },
        type: 'token_count',
      },
    ]);
    const events = codexAdapter.mapBatch?.('stop', {
      session_id: sessionId,
      transcript_path: path,
    });
    // The rollout holds a tool call, but PostToolUse already arrived as its own
    // hook — expanding it here would double-count.
    expect(events?.filter((e) => e.event_type === 'PostToolUse')).toHaveLength(0);
    expect(events?.filter((e) => e.event_type === 'Stop')).toHaveLength(1);
  });

  it('stands the notify path down when hooks are enabled (no double-counted turns)', () => {
    writeRollout([
      { arguments: '{}', call_id: 'c1', name: 'shell', type: 'function_call' },
      {
        info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } },
        type: 'token_count',
      },
    ]);
    enableHooks();
    expect(codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId })).toEqual([]);
  });

  it('ships the hook-provided transcript_path, keyed to the event session id', () => {
    const raw = { session_id: sessionId, transcript_path: '/tmp/rollout-abc.jsonl' };
    const target = codexAdapter.transcriptTarget('stop', raw);
    expect(target).toEqual({ sessionId, transcriptPath: '/tmp/rollout-abc.jsonl' });
  });

  it('prints the notify snippet when hooks are off and the hooks.json snippet when on', () => {
    const bin = '/usr/local/bin/claude-telemetry';

    const off = codexAdapter.installConfig();
    expect(off.settingsHint).toContain('notify');
    expect(off.renderSnippet(bin)).toContain('notify = [');
    // …and points the user at the richer path.
    expect(off.renderSnippet(bin)).toContain('hooks = true');

    enableHooks();
    const on = codexAdapter.installConfig();
    expect(on.settingsHint).toContain('hooks.json');
    const parsed = JSON.parse(on.renderSnippet(bin)) as {
      hooks: Record<string, { command: string[]; type: string }[]>;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
    // Exec form: a binary path with spaces must not be word-split.
    expect(parsed.hooks.PreToolUse?.[0]?.command).toEqual([
      bin,
      'hook',
      'pre-tool-use',
      '--agent',
      'codex',
    ]);
  });

  it('detects the deprecated codex_hooks alias and ignores commented-out flags', () => {
    writeFileSync(join(codexHome, 'config.toml'), '# hooks = true\n', 'utf8');
    resetCodexHooksCache();
    expect(codexHooksEnabled()).toBe(false);

    writeFileSync(join(codexHome, 'config.toml'), '[features]\ncodex_hooks = true\n', 'utf8');
    resetCodexHooksCache();
    expect(codexHooksEnabled()).toBe(true);
  });

  it('treats a hooks.json in CODEX_HOME as hooks being enabled', () => {
    writeFileSync(join(codexHome, 'hooks.json'), '{"hooks":{}}', 'utf8');
    resetCodexHooksCache();
    expect(codexHooksEnabled()).toBe(true);
  });
});
