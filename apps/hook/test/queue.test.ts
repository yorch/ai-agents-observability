import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHook } from '../src/hook-entry';
import { toEvent } from '../src/lib/payload';
import { openQueue } from '../src/lib/queue';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'claude-telemetry-test-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.CLAUDE_TELEMETRY_HOME;
});

describe('queue', () => {
  it('creates the events_queue table with WAL mode', () => {
    const q = openQueue();
    q.close();

    const db = new Database(`${tmpHome}/queue.db`);
    // WAL mode is database-level and persists across connections.
    // `synchronous` is connection-level so we can't assert it after reopen.
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    const cols = db
      .query<{ name: string }, []>('PRAGMA table_info(events_queue)')
      .all()
      .map((c) => c.name);
    db.close();

    expect(mode?.journal_mode).toBe('wal');
    expect(cols).toEqual(
      expect.arrayContaining(['event_id', 'ts', 'payload_json', 'attempted_at', 'attempts']),
    );
  });

  it('enqueues a row and deduplicates on event_id', () => {
    const q = openQueue();
    const row = {
      event_id: '01939f6c-1234-7000-8000-0123456789ab',
      payload_json: '{}',
      ts: '2026-05-21T12:00:00.000Z',
    };
    q.enqueue(row);
    q.enqueue(row); // INSERT OR IGNORE — second call is a no-op
    q.close();

    const db = new Database(`${tmpHome}/queue.db`);
    const count = db.query<{ c: number }, []>('SELECT count(*) AS c FROM events_queue').get();
    db.close();

    expect(count?.c).toBe(1);
  });
});

describe('payload → Event', () => {
  it('maps pre-tool-use into a schema-shaped Event', () => {
    const ev = toEvent('pre-tool-use', {
      cwd: '/home/dev/project',
      hook_event_name: 'PreToolUse',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
      tool_input: { command: 'ls' },
      tool_name: 'Bash',
    });
    expect(ev.event_type).toBe('PreToolUse');
    expect(ev.schema_version).toBe(1);
    expect(ev.session_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(ev.session_context.cwd).toBe('/home/dev/project');
    expect(ev.session_context.git).toBeNull();
    expect(ev.tool?.name).toBe('Bash');
    expect(ev.tool?.category).toBe('builtin');
    expect(ev.tool?.input_bytes).toBeGreaterThan(0);
    expect(ev.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('populates skill and slash_command when Skill tool is invoked', () => {
    const ev = toEvent('pre-tool-use', {
      cwd: '/home/dev/project',
      hook_event_name: 'PreToolUse',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
      tool_input: { args: 'quantum computing trends', skill: 'deep-research' },
      tool_name: 'Skill',
    });
    expect(ev.tool?.name).toBe('Skill');
    expect(ev.tool?.skill).toBe('deep-research');
    expect(ev.tool?.slash_command).toBe('deep-research');
  });

  it('leaves skill and slash_command null for non-Skill tools', () => {
    const ev = toEvent('pre-tool-use', {
      cwd: '/home/dev/project',
      hook_event_name: 'PreToolUse',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
      tool_input: { command: 'git status' },
      tool_name: 'Bash',
    });
    expect(ev.tool?.skill).toBeNull();
    expect(ev.tool?.slash_command).toBeNull();
  });

  it('extracts slash_command from UserPromptSubmit prompt into metadata', () => {
    const ev = toEvent('user-prompt-submit', {
      cwd: '/home/dev/project',
      hook_event_name: 'UserPromptSubmit',
      prompt: '/deep-research quantum computing trends',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(ev.event_type).toBe('UserPromptSubmit');
    expect(ev.metadata.slash_command).toBe('deep-research');
    // prompt is in KNOWN_KEYS — raw user messages must not land in metadata JSONB
    expect(ev.metadata.prompt).toBeUndefined();
  });

  it('leaves slash_command absent in metadata for plain UserPromptSubmit prompts', () => {
    const ev = toEvent('user-prompt-submit', {
      cwd: '/home/dev/project',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'what is the capital of France?',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(ev.metadata.slash_command).toBeUndefined();
    expect(ev.metadata.prompt).toBeUndefined();
  });

  it('handles missing prompt on UserPromptSubmit gracefully', () => {
    const ev = toEvent('user-prompt-submit', {
      cwd: '/home/dev/project',
      hook_event_name: 'UserPromptSubmit',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(ev.event_type).toBe('UserPromptSubmit');
    expect(ev.metadata.slash_command).toBeUndefined();
  });
});

function stubStdin(payload: string): () => void {
  const original = Bun.stdin.stream.bind(Bun.stdin);
  Bun.stdin.stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (payload.length > 0) {
          controller.enqueue(new TextEncoder().encode(payload));
        }
        controller.close();
      },
    });
  return () => {
    Bun.stdin.stream = original;
  };
}

describe('runHook', () => {
  it('writes one event from a piped stdin payload', async () => {
    const restore = stubStdin(
      JSON.stringify({
        cwd: '/tmp',
        hook_event_name: 'PreToolUse',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        tool_name: 'Read',
      }),
    );

    try {
      await runHook('pre-tool-use', { quiet: true });
    } finally {
      restore();
    }

    const db = new Database(`${tmpHome}/queue.db`);
    const row = db
      .query<{ payload_json: string; ts: string }, []>(
        'SELECT payload_json, ts FROM events_queue LIMIT 1',
      )
      .get();
    db.close();

    expect(row).not.toBeNull();
    const parsed = JSON.parse(row?.payload_json ?? '{}');
    expect(parsed.event_type).toBe('PreToolUse');
    expect(parsed.tool.name).toBe('Read');
  });

  it('does not throw when stdin is empty', async () => {
    const restore = stubStdin('');
    try {
      await runHook('stop', { quiet: true });
    } finally {
      restore();
    }
  });

  it('does NOT enqueue a synthetic event when stdin is empty', async () => {
    const restore = stubStdin('');
    try {
      await runHook('stop', { quiet: true });
    } finally {
      restore();
    }

    // Empty stdin must drop the event entirely — runHook should never even
    // open the queue. If it did, the events_queue table would exist (and a
    // synthetic event with sentinel session_id 00000000-... would pollute
    // ingest aggregation downstream).
    const db = new Database(`${tmpHome}/queue.db`);
    const table = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events_queue'",
      )
      .get();
    db.close();
    expect(table).toBeNull();
  });

  it('does not throw on invalid JSON', async () => {
    const restore = stubStdin('not-json{{');
    try {
      await runHook('stop', { quiet: true });
    } finally {
      restore();
    }
  });
});
