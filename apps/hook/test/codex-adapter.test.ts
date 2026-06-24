import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectAdapter } from '../src/adapters';
import { codexAdapter } from '../src/adapters/codex';

describe('codex adapter — selection & mapping', () => {
  it('is selectable by --agent codex and falls back to claude-code otherwise', () => {
    expect(selectAdapter('codex')).toBe(codexAdapter);
    expect(selectAdapter('codex').agentType).toBe('codex');
    expect(selectAdapter(undefined).agentType).toBe('claude-code');
    expect(selectAdapter('nonsense').agentType).toBe('claude-code');
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
    expect(ev.agent_type).toBe('codex');
    expect(ev.event_type).toBe('Stop');
    expect(ev.session_id).toBe('01906a44-0000-7000-8000-000000000000');
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
    expect(tools[0]?.agent_type).toBe('codex');
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
