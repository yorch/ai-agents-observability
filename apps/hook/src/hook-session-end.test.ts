import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeCodeAdapter } from './adapters/claude-code';
import type { HookAdapter, TailChunk } from './adapters/index';
import { runHook, TAIL_CHUNK_ROWS } from './hook-entry';
import { newSessionId, writeTranscript } from './lib/e2e-harness';
import { agentStateDir, shipQueueDir } from './lib/paths';

// The SessionEnd hook, end to end in one process: its own event, its ship marker,
// then the chunked usage tail. What a hook that dies part-way leaves behind, and
// what the queue cap does to the tail, are the point of these.

let home: string;
let sessionId: string;
let transcript: string;
let full: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiot-session-end-'));
  process.env.AIOT_HOME = home;
  sessionId = newSessionId();
  transcript = join(home, 'projects', `${sessionId}.jsonl`);
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.AIOT_QUEUE_MAX_EVENTS;
});

function stubStdin(payload: string): () => void {
  const original = Bun.stdin.stream.bind(Bun.stdin);
  Bun.stdin.stream = () =>
    new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload) as Uint8Array<ArrayBuffer>);
        controller.close();
      },
    });
  return () => {
    Bun.stdin.stream = original;
  };
}

function payload(event: 'Stop' | 'SessionEnd', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cwd: '/home/dev/proj',
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: transcript,
    ...(event === 'Stop' ? { stop_hook_active: false } : { reason: 'prompt_input_exit' }),
    ...extra,
  });
}

async function hook(
  kind: 'stop' | 'session-end',
  event: 'Stop' | 'SessionEnd',
  adapter: HookAdapter = claudeCodeAdapter,
  extra: Record<string, unknown> = {},
) {
  const restore = stubStdin(payload(event, extra));
  try {
    await runHook(kind, { quiet: true }, adapter);
  } finally {
    restore();
  }
}

/** Write the first `turns` turns of the full transcript (two lines per turn). */
function reveal(turns: number): void {
  writeFileSync(transcript, `${full.slice(0, turns * 2).join('\n')}\n`);
}

function makeTranscript(turns: number): void {
  writeTranscript(transcript, sessionId, '/home/dev/proj', turns);
  full = readFileSync(transcript, 'utf8').trimEnd().split('\n');
}

type Row = {
  event_type: string;
  event_id: string;
  llm?: { output_tokens: number };
  turn_number?: number;
};
function rows(): Row[] {
  const db = new Database(join(home, 'queue.db'));
  try {
    return db
      .query<{ payload_json: string }, []>('SELECT payload_json FROM events_queue')
      .all()
      .map((r) => JSON.parse(r.payload_json) as Row);
  } finally {
    db.close();
  }
}
const turnRows = () => rows().filter((r) => r.event_type === 'Stop' && r.llm);
const cursorFile = () => join(agentStateDir('claude-code'), `${sessionId}.json`);
const markerFile = () => join(shipQueueDir(), `${sessionId}.json`);

describe('SessionEnd hook: primary event, marker, then the usage tail', () => {
  it('queues the SessionEnd, writes the marker, queues every turn, commits the cursor', async () => {
    makeTranscript(5);
    await hook('session-end', 'SessionEnd');
    expect(rows().filter((r) => r.event_type === 'SessionEnd')).toHaveLength(1);
    expect(turnRows().map((r) => r.turn_number)).toEqual([1, 2, 3, 4, 5]);
    expect(existsSync(markerFile())).toBe(true);
    expect(JSON.parse(readFileSync(cursorFile(), 'utf8')).turns).toBe(5);
  });

  it('a tail that dies at once still leaves the SessionEnd and the marker, and nothing is lost', async () => {
    makeTranscript(5);
    const dying: HookAdapter = {
      ...claudeCodeAdapter,
      // biome-ignore lint/correctness/useYield: the point is that it never yields
      *tail() {
        throw new Error('killed');
      },
    };
    await hook('session-end', 'SessionEnd', dying);
    expect(rows().map((r) => r.event_type)).toEqual(['SessionEnd']);
    expect(existsSync(markerFile())).toBe(true);
    expect(existsSync(cursorFile())).toBe(false);

    await hook('session-end', 'SessionEnd'); // the next run reads it all
    expect(turnRows()).toHaveLength(5);
  });

  it('chunks commit as they go; a kill between a chunk’s enqueue and its commit duplicates nothing', async () => {
    makeTranscript(25);
    const killedAtSecondCommit: HookAdapter = {
      ...claudeCodeAdapter,
      *tail(kind, raw, opts) {
        let n = 0;
        for (const chunk of claudeCodeAdapter.tail?.(kind, raw, { ...opts, chunkSize: 10 }) ?? []) {
          n += 1;
          const out: TailChunk =
            n === 2
              ? {
                  commit() {
                    throw new Error('killed before the commit');
                  },
                  events: chunk.events,
                }
              : chunk;
          yield out;
        }
      },
    };
    await hook('session-end', 'SessionEnd', killedAtSecondCommit);
    // chunk 1 (10 turns) committed; chunk 2 queued (10 more) but its cursor never written
    expect(turnRows()).toHaveLength(20);
    expect(JSON.parse(readFileSync(cursorFile(), 'utf8')).turns).toBe(10);

    await hook('session-end', 'SessionEnd'); // resumes at turn 11, re-reading chunk 2
    const ids = turnRows().map((r) => r.event_id);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(JSON.parse(readFileSync(cursorFile(), 'utf8')).turns).toBe(25);
  });

  it('lets another writer take the lock between chunks; no chunk is bigger than TAIL_CHUNK_ROWS', async () => {
    // The lock-hold property, deterministically: whenever the hook asks for its next chunk
    // (so after it queued the last one and paused), a second connection with NO busy
    // timeout must be able to BEGIN IMMEDIATE, and the queue grew by at most one chunk.
    expect(TAIL_CHUNK_ROWS).toBeLessThanOrEqual(250); // ~1-3 ms transactions, not 100 ms ones
    makeTranscript(450);
    const growth: number[] = [];
    const sizes: number[] = [];
    let lastCount = 0;
    let lockTaken = 0;
    const probing: HookAdapter = {
      ...claudeCodeAdapter,
      *tail(kind, raw, opts) {
        for (const chunk of claudeCodeAdapter.tail?.(kind, raw, opts) ?? []) {
          const other = new Database(join(home, 'queue.db'));
          try {
            other.exec('PRAGMA busy_timeout = 0');
            other.exec('BEGIN IMMEDIATE'); // throws SQLITE_BUSY if the hook still holds the lock
            lockTaken += 1;
            const now = (
              other.query('SELECT count(*) AS c FROM events_queue').get() as { c: number }
            ).c;
            growth.push(now - lastCount);
            lastCount = now;
            other.exec('ROLLBACK');
          } finally {
            other.close();
          }
          sizes.push(chunk.events.length);
          yield chunk;
        }
      },
    };
    await hook('session-end', 'SessionEnd', probing);

    expect(turnRows()).toHaveLength(450);
    expect(lockTaken).toBe(Math.ceil(450 / TAIL_CHUNK_ROWS));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TAIL_CHUNK_ROWS);
    // growth[0] is the SessionEnd row alone (queued before the tail starts); the rest is one chunk each
    expect(growth[0]).toBe(1);
    expect(Math.max(...growth)).toBeLessThanOrEqual(TAIL_CHUNK_ROWS);
  });

  it('never prunes to make room: a tail that does not fit waits, with its cursor still behind it', async () => {
    process.env.AIOT_QUEUE_MAX_EVENTS = '60';
    makeTranscript(30);
    // Another session's 50 undelivered rows, older than every turn of this one.
    const db = new Database(join(home, 'queue.db'), { create: true });
    const { openQueue } = await import('./lib/queue');
    openQueue().close(); // creates the schema
    for (let i = 0; i < 50; i++) {
      db.run('INSERT INTO events_queue (event_id, ts, payload_json) VALUES (?, ?, ?)', [
        `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
        '{}',
      ]);
    }
    db.close();

    await hook('session-end', 'SessionEnd');
    // The SessionEnd (51 rows) fit; the 30 turns (51 + 30 > 60) were refused whole.
    const after = rows();
    expect(after).toHaveLength(51);
    expect(after.filter((r) => r.llm)).toHaveLength(0);
    expect(existsSync(cursorFile())).toBe(false);

    // Delivered meanwhile: the queue drains, and the next SessionEnd/Stop finds room.
    const drain = new Database(join(home, 'queue.db'));
    drain.run("DELETE FROM events_queue WHERE json_extract(payload_json, '$.event_type') IS NULL");
    drain.close();
    await hook('session-end', 'SessionEnd');
    expect(turnRows()).toHaveLength(30);
    expect(JSON.parse(readFileSync(cursorFile(), 'utf8')).turns).toBe(30);
  });
});

describe('ground truth across Stop, tail, SessionEnd, resume', () => {
  it('counts every turn exactly once: tokens equal the transcript, ordinals 1..N, distinct ids', async () => {
    makeTranscript(7); // 420 output tokens per turn
    reveal(2);
    await hook('stop', 'Stop');
    reveal(4); // a tail after the last Stop, ended with /clear
    await hook('session-end', 'SessionEnd', claudeCodeAdapter, { reason: 'clear' });
    reveal(6); // the session is resumed; this Stop carries stop_hook_active
    await hook('stop', 'Stop', claudeCodeAdapter, { stop_hook_active: true });
    await hook('session-end', 'SessionEnd'); // nothing new to read
    reveal(7);
    await hook('session-end', 'SessionEnd');
    await hook('session-end', 'SessionEnd'); // and again

    const turns = turnRows();
    expect(turns).toHaveLength(7);
    expect(new Set(turns.map((r) => r.event_id)).size).toBe(7);
    expect(turns.map((r) => r.turn_number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(turns.reduce((n, r) => n + (r.llm?.output_tokens ?? 0), 0)).toBe(7 * 420);
  });
});
