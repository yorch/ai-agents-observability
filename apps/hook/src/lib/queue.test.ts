import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toEvent } from '../adapters/claude-code';
import { runHook } from '../hook-entry';
import { openQueue } from './queue';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-test-'));
  process.env.AIOT_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
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

  it('prunes oldest rows when event count exceeds AIOT_QUEUE_MAX_EVENTS', () => {
    process.env.AIOT_QUEUE_MAX_EVENTS = '3';
    const q = openQueue();
    for (let i = 0; i < 5; i++) {
      q.enqueue({
        event_id: `01939f6c-1234-7000-8000-${i.toString().padStart(12, '0')}`,
        payload_json: `{"i":${i}}`,
        ts: `2026-05-21T12:00:0${i}.000Z`,
      });
    }
    q.close();

    const db = new Database(`${tmpHome}/queue.db`);
    const rows = db
      .query<{ event_id: string }, []>('SELECT event_id FROM events_queue ORDER BY ts ASC')
      .all();
    db.close();

    // Only the 3 newest survive; the 2 oldest were pruned.
    expect(rows).toHaveLength(3);
    expect(rows[0]?.event_id).toBe('01939f6c-1234-7000-8000-000000000002');
    expect(rows[2]?.event_id).toBe('01939f6c-1234-7000-8000-000000000004');
    delete process.env.AIOT_QUEUE_MAX_EVENTS;
  });

  it('prunes oldest rows when DB file exceeds AIOT_QUEUE_MAX_BYTES', () => {
    // Use a tiny byte cap so even a few small rows trigger it.
    process.env.AIOT_QUEUE_MAX_BYTES = '1024';
    const q = openQueue();
    // Enqueue enough rows with non-trivial payloads to exceed 1 KB.
    for (let i = 0; i < 20; i++) {
      q.enqueue({
        event_id: `01939f6c-1234-7000-8000-${i.toString().padStart(12, '0')}`,
        payload_json: JSON.stringify({ data: 'x'.repeat(200), i }),
        ts: `2026-05-21T12:00:0${i}.000Z`,
      });
    }
    q.close();

    const db = new Database(`${tmpHome}/queue.db`);
    const count = db.query<{ c: number }, []>('SELECT count(*) AS c FROM events_queue').get();
    db.close();

    // Some rows should have been pruned — the count should be well under 20.
    expect(count?.c).toBeLessThan(20);
    delete process.env.AIOT_QUEUE_MAX_BYTES;
  });

  it('does not prune when under the caps', () => {
    const q = openQueue();
    for (let i = 0; i < 10; i++) {
      q.enqueue({
        event_id: `01939f6c-1234-7000-8000-${i.toString().padStart(12, '0')}`,
        payload_json: `{"i":${i}}`,
        ts: `2026-05-21T12:00:0${i}.000Z`,
      });
    }
    q.close();

    const db = new Database(`${tmpHome}/queue.db`);
    const count = db.query<{ c: number }, []>('SELECT count(*) AS c FROM events_queue').get();
    db.close();

    // Default caps (50k events, 100 MB) — nothing should be pruned.
    expect(count?.c).toBe(10);
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
    expect(ev.tool?.category).toBe('exec');
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
    new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        if (payload.length > 0) {
          controller.enqueue(new TextEncoder().encode(payload) as Uint8Array<ArrayBuffer>);
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
