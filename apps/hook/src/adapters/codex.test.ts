import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectAdapter } from '.';
import {
  codexAdapter,
  codexHooksFeatureEnabled,
  codexHooksWired,
  resetCodexHooksCache,
} from './codex';
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

  it('subtracts the cached tokens OpenAI counts inside input_tokens', () => {
    // OpenAI's input_tokens is the whole prompt: 1000 total = 600 cache reads +
    // 100 cache writes + 300 genuinely new. Emitting 1000 alongside the two cache
    // counts makes ingest bill the cached 700 twice.
    writeRollout([
      { model: 'gpt-5.3-codex', type: 'turn_context' },
      {
        info: {
          total_token_usage: {
            cache_creation_tokens: 100,
            cached_input_tokens: 600,
            input_tokens: 1000,
            output_tokens: 200,
          },
        },
        type: 'token_count',
      },
    ]);

    const stop = codexAdapter
      .mapBatch?.('turn-complete', { 'session-id': sessionId })
      ?.find((e) => e.event_type === 'Stop');
    expect(stop?.llm?.input_tokens).toBe(300);
    expect(stop?.llm?.cache_read_tokens).toBe(600);
    expect(stop?.llm?.cache_creation_tokens).toBe(100);
  });

  it('clamps input to zero rather than emitting a negative count', () => {
    // A rollout we do not control could report cache counts exceeding the total.
    writeRollout([
      { model: 'gpt-5.3-codex', type: 'turn_context' },
      {
        info: { total_token_usage: { cached_input_tokens: 900, input_tokens: 500 } },
        type: 'token_count',
      },
    ]);

    const stop = codexAdapter
      .mapBatch?.('turn-complete', { 'session-id': sessionId })
      ?.find((e) => e.event_type === 'Stop');
    expect(stop?.llm?.input_tokens).toBe(0);
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

  // Codex's hook system on, AND our binary registered as a hook — the stand-down
  // requires the second half, not just the feature flag.
  function enableHooks(): void {
    writeFileSync(join(codexHome, 'config.toml'), '[features]\nhooks = true\n', 'utf8');
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              command: ['/bin/claude-telemetry', 'hook', 'stop', '--agent', 'codex'],
              type: 'command',
            },
          ],
        },
      }),
      'utf8',
    );
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

  it('keeps reporting the model past the second turn', () => {
    // The model appears once, on a turn_context record near the top of the file.
    // Without carrying it forward in the cursor, turn 3 onward reported
    // `model: unknown` and therefore priced at $0.
    const path = rolloutPath();
    const turns = [
      { model: 'gpt-5-codex', type: 'turn_context' },
      {
        info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        type: 'token_count',
      },
    ];
    const write = () =>
      writeFileSync(path, `${turns.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    write();

    const models: (string | undefined)[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      const stop = codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId })?.at(-1);
      models.push(stop?.llm?.model);
      turns.push({
        info: { total_token_usage: { input_tokens: 100 * (turn + 1), output_tokens: 10 } },
        type: 'token_count',
      });
      write();
    }
    expect(models).toEqual(['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex']);
  });

  it("does not apply one file's offset to another (cursor is per file)", () => {
    // The hooks path trusts transcript_path; notify scans for the rollout. Both
    // write the same session's cursor, so an offset carried across files would
    // skip a turn's records entirely.
    const rollout = writeRollout([
      { model: 'gpt-5-codex', type: 'turn_context' },
      {
        info: { total_token_usage: { input_tokens: 900, output_tokens: 90 } },
        type: 'token_count',
      },
    ]);
    const other = join(codexHome, 'elsewhere.jsonl');
    writeFileSync(other, `${'x'.repeat(5000)}\n`, 'utf8');

    // A Stop hook pointed at a much larger, unrelated file.
    codexAdapter.mapBatch?.('stop', { session_id: sessionId, transcript_path: other });
    // The real rollout must still be read from the start.
    const stop = codexAdapter
      .mapBatch?.('stop', { session_id: sessionId, transcript_path: rollout })
      ?.at(-1);
    expect(stop?.llm?.input_tokens).toBe(900);
  });

  it('does not guess a rollout when the hook payload omits transcript_path', () => {
    // The scan returns the newest rollout of ANY session: with two Codex sessions
    // running it would bill one session's tokens to the other.
    writeRollout([
      {
        info: { total_token_usage: { input_tokens: 5000, output_tokens: 900 } },
        type: 'token_count',
      },
    ]);
    const other = '0190abcd-3333-7000-8000-000000000003';
    const events = codexAdapter.mapBatch?.('stop', { model: 'gpt-5-codex', session_id: other });
    // No tokens are invented from the other session's rollout…
    expect(events?.[0]?.llm?.input_tokens).toBe(0);
    // …but the model still rides along, so the turn stays attributable.
    expect(events?.[0]?.llm?.model).toBe('gpt-5-codex');
  });

  it('keeps capturing when somebody else owns the hooks config', () => {
    // Standing the notify path down on a foreign hooks.json would black out a
    // correctly-installed notify user entirely.
    writeRollout([
      { info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } }, type: 'token_count' },
    ]);
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ command: ['/usr/bin/their-linter'], type: 'command' }] },
      }),
      'utf8',
    );
    resetCodexHooksCache();
    const events = codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId });
    expect(events?.length).toBeGreaterThan(0);
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

  it('reads the feature flag TOML-aware: comments, tables and the deprecated alias', () => {
    const cases: [string, boolean][] = [
      ['# hooks = true\n', false],
      ['[features]\nhooks = true\n', true],
      ['[features]\ncodex_hooks = true\n', true],
      // Trailing comments are legal TOML and must not defeat the match.
      ['[features]\nhooks = true # experimental\n', true],
      // Inline tables are legal TOML too.
      ['features = { hooks = true }\n', true],
      // A `hooks` key under a DIFFERENT table is a different setting.
      ['[tui]\nhooks = true\n', false],
      ['[features]\nhooks = false\n', false],
      ['[features]\nhooks = "true"\n', true],
    ];
    for (const [toml, expected] of cases) {
      writeFileSync(join(codexHome, 'config.toml'), toml, 'utf8');
      resetCodexHooksCache();
      expect({ on: codexHooksFeatureEnabled(), toml }).toEqual({ on: expected, toml });
    }
  });

  it('does not mistake OUR OWN notify snippet in config.toml for a wired hook', () => {
    // The notify install snippet writes
    // `notify = ["~/.codex/claude-telemetry-notify.sh"]` into config.toml. A
    // substring test for our binary's name matches that — so the default,
    // documented install would stand the notify path down and capture NOTHING.
    // What a notify install actually puts in config.toml: the notify line only.
    // (The wrapper script, which does contain the hook invocation, lives in its
    // own .sh file — config.toml never sees it.)
    const bin = '/usr/local/bin/claude-telemetry';
    resetCodexHooksCache();
    const notifyLine = codexAdapter
      .installConfig()
      .renderSnippet(bin)
      .split('\n')
      .find((line) => line.startsWith('notify = ['));
    expect(notifyLine).toContain('claude-telemetry');
    writeFileSync(join(codexHome, 'config.toml'), `${notifyLine}\n`, 'utf8');
    resetCodexHooksCache();
    expect(codexHooksWired()).toBe(false);

    // …and the notify path keeps emitting.
    writeRollout([
      { info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } }, type: 'token_count' },
    ]);
    expect(
      codexAdapter.mapBatch?.('turn-complete', { 'session-id': sessionId })?.length,
    ).toBeGreaterThan(0);
  });

  it('detects our hook wired via an inline [hooks] table in config.toml', () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      '[hooks]\nStop = "claude-telemetry hook stop --agent codex"\n',
      'utf8',
    );
    resetCodexHooksCache();
    expect(codexHooksWired()).toBe(true);
  });

  it("does not treat somebody else's hooks.json as our binary being wired", () => {
    // A user's own lint hook must not stand the notify path down — that would be
    // a total telemetry blackout for a correctly-installed notify user.
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ command: ['/usr/bin/their-linter'], type: 'command' }] },
      }),
      'utf8',
    );
    resetCodexHooksCache();
    expect(codexHooksWired()).toBe(false);
  });

  it('detects our binary in hooks.json', () => {
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              command: ['/opt/claude-telemetry', 'hook', 'stop', '--agent', 'codex'],
              type: 'command',
            },
          ],
        },
      }),
      'utf8',
    );
    resetCodexHooksCache();
    expect(codexHooksWired()).toBe(true);
  });
});
