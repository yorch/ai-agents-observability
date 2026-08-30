import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventSchema } from '@ai-agents-observability/schemas';

import { conformanceErrors } from '../adapters/conformance';
import { codexImportSource } from './import-source-codex';
import { opencodeImportSource } from './import-source-opencode';
import { ompImportSource, piImportSource } from './import-source-pi';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-import-source-'));
  process.env.AIOT_HOME = join(dir, 'telemetry');
});

afterEach(() => {
  delete process.env.AIOT_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODE_DATA;
  delete process.env.OMP_HOME;
  delete process.env.PI_HOME;
  rmSync(dir, { force: true, recursive: true });
});

function writeJsonl(path: string, records: object[], prefix = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${prefix}${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
}

function expectConformant(events: unknown[]): void {
  for (const event of events) {
    expect(EventSchema.safeParse(event).success).toBe(true);
    expect(conformanceErrors(event)).toEqual([]);
  }
}

describe('Codex historical import source', () => {
  it('discovers rollouts and emits deterministic turn, tool, and usage events', async () => {
    process.env.CODEX_HOME = join(dir, 'codex');
    const nativeId = '01a044fe-9f6b-7e10-b8ae-d01c6a1148ae';
    const path = join(
      process.env.CODEX_HOME,
      'sessions',
      '2026',
      '08',
      '27',
      `rollout-2026-08-27T16-52-12-${nativeId}.jsonl`,
    );
    writeJsonl(path, [
      {
        payload: { cli_version: '0.150.1', cwd: '/repo', session_id: nativeId },
        timestamp: '2026-08-27T16:52:12.000Z',
        type: 'session_meta',
      },
      {
        payload: { model: 'gpt-5.3-codex', turn_id: 'turn-1' },
        timestamp: '2026-08-27T16:52:13.000Z',
        type: 'turn_context',
      },
      {
        payload: { turn_id: 'turn-1', type: 'task_started' },
        timestamp: '2026-08-27T16:52:14.000Z',
        type: 'event_msg',
      },
      {
        payload: { type: 'user_message' },
        timestamp: '2026-08-27T16:52:15.000Z',
        type: 'event_msg',
      },
      {
        payload: {
          arguments: '{"path":"a"}',
          call_id: 'call-1',
          name: 'read',
          type: 'function_call',
        },
        timestamp: '2026-08-27T16:52:16.000Z',
        type: 'response_item',
      },
      {
        payload: { call_id: 'call-1', output: 'ok', type: 'function_call_output' },
        timestamp: '2026-08-27T16:52:17.000Z',
        type: 'response_item',
      },
      {
        payload: {
          info: {
            total_token_usage: { cached_input_tokens: 20, input_tokens: 100, output_tokens: 30 },
          },
          type: 'token_count',
        },
        timestamp: '2026-08-27T16:52:18.000Z',
        type: 'event_msg',
      },
      {
        payload: { type: 'task_complete' },
        timestamp: '2026-08-27T16:52:19.000Z',
        type: 'event_msg',
      },
      {
        payload: { turn_id: 'turn-2', type: 'task_started' },
        timestamp: '2026-08-27T16:52:20.000Z',
        type: 'event_msg',
      },
      {
        payload: {
          info: {
            total_token_usage: { cached_input_tokens: 30, input_tokens: 150, output_tokens: 45 },
          },
          type: 'token_count',
        },
        timestamp: '2026-08-27T16:52:21.000Z',
        type: 'event_msg',
      },
      {
        payload: { type: 'task_complete' },
        timestamp: '2026-08-27T16:52:22.000Z',
        type: 'event_msg',
      },
    ]);

    const session = codexImportSource.discover()[0];
    expect(session).toBeDefined();
    const first = await session?.events(null);
    const second = await session?.events(null);
    expect(first?.map((event) => event.event_type)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'Stop',
    ]);
    const stops = first?.filter((event) => event.event_type === 'Stop') ?? [];
    expect(stops[0]?.llm).toMatchObject({
      cache_read_tokens: 20,
      input_tokens: 80,
      model: 'gpt-5.3-codex',
      output_tokens: 30,
    });
    expect(stops[1]?.llm).toMatchObject({
      cache_read_tokens: 10,
      input_tokens: 40,
      model: 'gpt-5.3-codex',
      output_tokens: 15,
    });
    expect(first?.map((event) => event.event_id)).toEqual(second?.map((event) => event.event_id));
    expectConformant(first ?? []);
  });

  it('accepts legacy flat rollout records', async () => {
    process.env.CODEX_HOME = join(dir, 'codex-flat');
    const nativeId = '01a044fe-9f6b-7e10-b8ae-d01c6a1148af';
    const path = join(process.env.CODEX_HOME, 'sessions', `rollout-${nativeId}.jsonl`);
    writeJsonl(path, [
      {
        cwd: '/repo',
        session_id: nativeId,
        timestamp: '2026-08-27T16:52:12.000Z',
        type: 'session_meta',
      },
      { timestamp: '2026-08-27T16:52:13.000Z', type: 'task_started' },
      { timestamp: '2026-08-27T16:52:14.000Z', type: 'user_message' },
      {
        arguments: '{}',
        call_id: 'call-flat',
        name: 'read',
        timestamp: '2026-08-27T16:52:15.000Z',
        type: 'function_call',
      },
      {
        call_id: 'call-flat',
        output: 'ok',
        timestamp: '2026-08-27T16:52:16.000Z',
        type: 'function_call_output',
      },
      {
        input_tokens: 10,
        output_tokens: 5,
        timestamp: '2026-08-27T16:52:17.000Z',
        type: 'token_count',
      },
      { timestamp: '2026-08-27T16:52:18.000Z', type: 'task_complete' },
    ]);

    const events = await codexImportSource.discover()[0]?.events(null);
    expect(events?.map((event) => event.event_type)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
    expectConformant(events ?? []);
  });
});

function piFamilyFixture(home: string, nativeId: string, omp = false): string {
  const path = join(home, 'agent', 'sessions', 'project', `2026-08-27T17-22-00Z_${nativeId}.jsonl`);
  writeJsonl(
    path,
    [
      { cwd: '/repo', id: nativeId, timestamp: '2026-08-27T17:22:00.000Z', type: 'session' },
      {
        id: 'user-1',
        message: { content: [{ text: 'hello', type: 'text' }], role: 'user' },
        parentId: null,
        timestamp: '2026-08-27T17:22:01.000Z',
        type: 'message',
      },
      {
        id: 'assistant-1',
        message: {
          content: [{ arguments: { path: 'a' }, id: 'call-1', name: 'read', type: 'toolCall' }],
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          usage: { cacheRead: 10, cacheWrite: 0, input: 40, output: 20 },
        },
        parentId: 'user-1',
        timestamp: '2026-08-27T17:22:02.000Z',
        type: 'message',
      },
      {
        id: 'result-1',
        message: {
          content: [{ text: 'ok', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
        },
        parentId: 'assistant-1',
        timestamp: '2026-08-27T17:22:03.000Z',
        type: 'message',
      },
      {
        customType: 'session_exit',
        id: 'exit-1',
        parentId: 'result-1',
        timestamp: '2026-08-27T17:22:04.000Z',
        type: 'custom',
      },
    ],
    omp ? `${' '.repeat(256)}` : '',
  );
  return path;
}

describe('Pi-family historical import sources', () => {
  it('imports Pi session events and links tool calls to their turn', async () => {
    process.env.PI_HOME = join(dir, 'pi');
    piFamilyFixture(process.env.PI_HOME, '01a0443e-2b70-7000-b3b2-e6b8283f80b5');
    const session = piImportSource.discover()[0];
    const events = await session?.events(null);
    expect(events?.map((event) => event.event_type)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'Stop',
      'PostToolUse',
      'SessionEnd',
    ]);
    const stop = events?.find((event) => event.event_type === 'Stop');
    const post = events?.find((event) => event.event_type === 'PostToolUse');
    expect(post?.parent_event_id).toBe(stop?.event_id);
    expect(post?.tool?.tool_use_id).toBe('call-1');
    expectConformant(events ?? []);

    const filtered = await session?.events(new Date('2026-08-27T17:22:02.500Z'));
    expect(
      filtered?.find((event) => event.event_type === 'PostToolUse')?.parent_event_id,
    ).toBeNull();
  });

  it('imports OMP files with the padded title preamble', async () => {
    process.env.OMP_HOME = join(dir, 'omp');
    piFamilyFixture(process.env.OMP_HOME, 'abcd1234abcd1234', true);
    const session = ompImportSource.discover()[0];
    const events = await session?.events(null);
    expect(events).toHaveLength(6);
    expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expectConformant(events ?? []);
  });
});

describe('OpenCode historical import source', () => {
  it('reads the SQLite store and stages a disposable transcript', async () => {
    const dataRoot = join(dir, 'opencode');
    process.env.OPENCODE_DATA = join(dataRoot, 'storage');
    mkdirSync(process.env.OPENCODE_DATA, { recursive: true });
    const db = new Database(join(dataRoot, 'opencode.db'));
    db.run(
      'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)',
    );
    db.run(
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    db.run(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?)', [
      'ses_example',
      '/repo',
      1_787_843_200_000,
      1_787_843_204_000,
      null,
    ]);
    db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [
      'msg-user',
      'ses_example',
      1_787_843_201_000,
      1_787_843_201_000,
      JSON.stringify({ role: 'user', time: { created: 1_787_843_201_000 } }),
    ]);
    db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [
      'msg-assistant',
      'ses_example',
      1_787_843_202_000,
      1_787_843_204_000,
      JSON.stringify({
        modelID: 'claude-sonnet-4-5',
        role: 'assistant',
        time: { completed: 1_787_843_204_000, created: 1_787_843_202_000 },
        tokens: { cache: { read: 5, write: 0 }, input: 20, output: 10, reasoning: 2 },
      }),
    ]);
    db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [
      'part-tool',
      'msg-assistant',
      'ses_example',
      1_787_843_202_000,
      1_787_843_203_000,
      JSON.stringify({
        callID: 'call-1',
        state: {
          input: { path: 'a' },
          output: 'ok',
          status: 'completed',
          time: { end: 1_787_843_203_000, start: 1_787_843_202_000 },
        },
        tool: 'read',
        type: 'tool',
      }),
    ]);
    db.close();

    const session = opencodeImportSource.discover()[0];
    const events = await session?.events(null);
    expect(events?.map((event) => event.event_type)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
    const pre = events?.find((event) => event.event_type === 'PreToolUse');
    const post = events?.find((event) => event.event_type === 'PostToolUse');
    expect(pre?.tool?.output_bytes).toBe(0);
    expect(pre?.tool?.exit_status).toBe(null);
    expect(post?.tool?.exit_status).toBe(0);
    expect(events?.find((event) => event.event_type === 'Stop')?.llm?.output_tokens).toBe(12);
    expectConformant(events ?? []);
    const prepared = session?.prepareTranscript();
    expect(prepared?.path).toBeTruthy();
    expect(statSync(prepared?.path ?? '').mode & 0o777).toBe(0o600);
    prepared?.cleanup?.();
    expect(existsSync(prepared?.path ?? '')).toBe(false);
  });
});
