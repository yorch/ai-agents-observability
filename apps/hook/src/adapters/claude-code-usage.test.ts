import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeCodeAdapter } from './claude-code';
import { conformanceErrors } from './conformance';

// Per-turn usage capture on the LIVE Claude Code path (P14-003).
//
// Before this, Claude Code's hook payload carried no token usage on any hook, so
// a live-captured session recorded $0 forever. The usage is read from the
// transcript the Stop payload already points at, incrementally, and folded onto
// one Stop event per assistant turn.
//
// Model ids are copied from apps/ingest/src/data/price-table.claude_code.v1.json
// — a plausible-but-nonexistent model prices at $0, which is the failure this
// whole task exists to fix (see apps/hook/AGENTS.md).
const MODEL = 'claude-opus-4-5-20251101';
const SESSION_ID = '3f8c2a1e-9d47-4b6a-8c25-1e7f0a9b4d63';

let home: string;
let transcript: string;

function assistantLine(
  uuid: string,
  ts: string,
  usage: Record<string, number> | null,
  toolUse?: { id: string; name: string },
): string {
  const content: unknown[] = [{ text: 'working on it', type: 'text' }];
  if (toolUse) {
    content.push({
      id: toolUse.id,
      input: { command: 'ls' },
      name: toolUse.name,
      type: 'tool_use',
    });
  }
  return `${JSON.stringify({
    cwd: '/home/dev/proj',
    message: { content, model: MODEL, role: 'assistant', ...(usage ? { usage } : {}) },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'assistant',
    uuid,
  })}\n`;
}

function userLine(uuid: string, ts: string): string {
  return `${JSON.stringify({
    cwd: '/home/dev/proj',
    message: { content: 'do the thing', role: 'user' },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'user',
    uuid,
  })}\n`;
}

const USAGE = {
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 12_000,
  input_tokens: 1500,
  output_tokens: 420,
};

function stopPayload(path: string = transcript): Record<string, unknown> {
  return {
    cwd: '/home/dev/proj',
    hook_event_name: 'Stop',
    session_id: SESSION_ID,
    transcript_path: path,
  };
}

function batch(payload = stopPayload()) {
  return claudeCodeAdapter.mapBatch?.('stop', payload) ?? null;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-usage-test-'));
  process.env.CLAUDE_TELEMETRY_HOME = home;
  transcript = join(home, 'session.jsonl');
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
  process.env.CLAUDE_TELEMETRY_HOME = undefined;
});

describe('claudeCodeAdapter per-turn usage', () => {
  it('folds a turn’s token usage onto a schema-conformant Stop event', () => {
    writeFileSync(
      transcript,
      userLine('u1', '2026-08-20T10:00:00.000Z') +
        assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE),
    );

    const events = batch();
    expect(events).toHaveLength(1);
    const stop = events?.[0];
    expect(conformanceErrors(stop)).toEqual([]);
    expect(stop?.event_type).toBe('Stop');
    expect(stop?.llm).toEqual({
      cache_creation_tokens: 300,
      cache_read_tokens: 12_000,
      // Adapters never price; ingest recomputes from the price table (DESIGN_DOC §6.7).
      cost_usd: 0,
      // Anthropic's counts are already disjoint — input_tokens must be passed
      // through unchanged, NOT reduced by the cache counters.
      input_tokens: 1500,
      model: MODEL,
      output_tokens: 420,
    });
    // The Stop takes the transcript entry's own timestamp, not the hook's clock.
    expect(stop?.ts).toBe('2026-08-20T10:00:05.000Z');
  });

  it('emits one Stop per assistant turn, numbered 1-based and monotonically', () => {
    writeFileSync(
      transcript,
      userLine('u1', '2026-08-20T10:00:00.000Z') +
        assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE) +
        assistantLine('a2', '2026-08-20T10:00:09.000Z', USAGE) +
        assistantLine('a3', '2026-08-20T10:00:12.000Z', USAGE),
    );

    const events = batch();
    expect(events?.map((e) => e.turn_number)).toEqual([1, 2, 3]);
    expect(new Set(events?.map((e) => e.event_id)).size).toBe(3);
  });

  it('leaves parent_event_id null on the Stop itself', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    expect(batch()?.[0]?.parent_event_id ?? null).toBeNull();
  });

  it('carries no llm block for a turn that reported no usage', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', null));
    const stop = batch()?.[0];
    expect(stop?.turn_number).toBe(1);
    expect(stop?.llm ?? null).toBeNull();
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('treats an all-zero usage block as no usage rather than a $0 turn', () => {
    writeFileSync(
      transcript,
      assistantLine('a1', '2026-08-20T10:00:05.000Z', {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      }),
    );
    expect(batch()?.[0]?.llm ?? null).toBeNull();
  });
});

describe('claudeCodeAdapter incremental transcript read', () => {
  it('reads only what is new on the second Stop and never re-attributes usage', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    const first = batch();
    expect(first?.map((e) => e.turn_number)).toEqual([1]);

    // Turn two is appended; the second Stop must see ONLY it.
    writeFileSync(
      transcript,
      assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE) +
        assistantLine('a2', '2026-08-20T10:00:20.000Z', USAGE),
    );
    const second = batch();
    expect(second).toHaveLength(1);
    expect(second?.[0]?.turn_number).toBe(2);
    expect(second?.[0]?.event_id).not.toBe(first?.[0]?.event_id);
  });

  it('falls back to the plain single Stop when nothing new was appended', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    expect(batch()).toHaveLength(1);
    // null = "no batch", which hook-entry turns into the ordinary Stop event, so
    // the session's end signal survives a turn with no new transcript entries.
    expect(batch()).toBeNull();
  });

  it('ignores a half-written final line until it is complete', () => {
    const complete = assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE);
    writeFileSync(transcript, `${complete}{"type":"assistant","uuid":"a2","mess`);
    expect(batch()?.map((e) => e.turn_number)).toEqual([1]);

    writeFileSync(transcript, complete + assistantLine('a2', '2026-08-20T10:00:20.000Z', USAGE));
    expect(batch()?.map((e) => e.turn_number)).toEqual([2]);
  });

  it('restarts numbering when the session’s transcript path changes', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    expect(batch()?.[0]?.turn_number).toBe(1);

    // A cursor offset is only meaningful against the file it was measured in, and
    // the ordinal is an ordinal WITHIN that file.
    const other = join(home, 'other.jsonl');
    writeFileSync(other, assistantLine('b1', '2026-08-20T11:00:00.000Z', USAGE));
    expect(batch(stopPayload(other))?.[0]?.turn_number).toBe(1);
  });
});

describe('claudeCodeAdapter usage read degrades instead of throwing', () => {
  // The always-exit-0 rule applied to money: an unreadable transcript costs the
  // turn its usage, never the turn itself. Every case returns null so hook-entry
  // falls back to the ordinary Stop.
  it('returns null when the transcript file does not exist', () => {
    expect(() => batch(stopPayload(join(home, 'missing.jsonl')))).not.toThrow();
    expect(batch(stopPayload(join(home, 'missing.jsonl')))).toBeNull();
  });

  it('returns null when the payload carries no transcript_path', () => {
    const payload = stopPayload();
    payload.transcript_path = undefined;
    expect(batch(payload)).toBeNull();
  });

  it('returns null when the session id is unusable', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    const payload = stopPayload();
    payload.session_id = '';
    // A nil session id would make every unknown session share one cursor file.
    expect(batch(payload)).toBeNull();
  });

  it('returns null when the transcript is a directory, not a file', () => {
    const dir = join(home, 'not-a-file');
    mkdirSync(dir);
    expect(() => batch(stopPayload(dir))).not.toThrow();
    expect(batch(stopPayload(dir))).toBeNull();
  });

  it('returns null when the transcript cannot be opened', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    chmodSync(transcript, 0o000);
    try {
      expect(() => batch()).not.toThrow();
      expect(batch()).toBeNull();
    } finally {
      chmodSync(transcript, 0o600);
    }
  });

  it('skips malformed lines and still emits the turns around them', () => {
    writeFileSync(
      transcript,
      assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE) +
        '{ not json at all\n' +
        '\n' +
        assistantLine('a2', '2026-08-20T10:00:20.000Z', USAGE),
    );
    const events = batch();
    // The malformed line does NOT advance the ordinal — import skips it the same
    // way, so both paths agree that these are turns 1 and 2.
    expect(events?.map((e) => e.turn_number)).toEqual([1, 2]);
  });

  it('survives a usage block whose counts are not numbers', () => {
    writeFileSync(
      transcript,
      `${JSON.stringify({
        message: {
          content: [],
          model: MODEL,
          role: 'assistant',
          usage: { input_tokens: 'lots', output_tokens: null },
        },
        timestamp: '2026-08-20T10:00:05.000Z',
        type: 'assistant',
        uuid: 'a1',
      })}\n`,
    );
    const stop = batch()?.[0];
    expect(stop?.llm ?? null).toBeNull();
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('only expands the stop hook', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    // SubagentStop reads no transcript: subagent turns are sidechain entries in
    // the SAME file, so the main Stop's incremental read already covers them.
    expect(claudeCodeAdapter.mapBatch?.('subagent-stop', stopPayload()) ?? null).toBeNull();
    expect(claudeCodeAdapter.mapBatch?.('pre-tool-use', stopPayload()) ?? null).toBeNull();
  });
});
