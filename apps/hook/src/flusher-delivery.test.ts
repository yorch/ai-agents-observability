import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFlusherStatus, runFlusher } from './flusher';
import { MAX_AGE_MS, MAX_ATTEMPTS, openQueueReader } from './lib/queue-reader';

// These drive the REAL flusher loop (not a re-implementation of it). Bun.sleep
// is replaced so backoff costs no wall time and records the delay the loop
// asked for; it throws a sentinel to break the otherwise endless loop once the
// scenario has run long enough. `runFlusher`'s own `finally` closes the reader.

class StopLoop extends Error {}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-flusher-delivery-'));
  process.env.AIOT_HOME = tmpHome;
  writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-jwt-token' }));
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.INGEST_BASE_URL;
});

function seedQueue(count: number, ts = new Date().toISOString()): string {
  const dbPath = join(tmpHome, 'queue.db');
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events_queue (
      event_id     TEXT PRIMARY KEY,
      ts           TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempted_at TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_queue_ts_idx ON events_queue (ts);
  `);
  const insert = db.prepare(
    'INSERT INTO events_queue (event_id, ts, payload_json) VALUES (?, ?, ?)',
  );
  for (let i = 0; i < count; i++) {
    const id = `0192f3a0-7c1e-7b2a-9d4e-${String(i).padStart(12, '0')}`;
    insert.run(
      id,
      ts,
      JSON.stringify({
        agent_type: 'claude-code',
        event_id: id,
        event_type: 'PostToolUse',
        session_context: { cwd: tmpHome },
        session_id: '5f0c1d52-8a3e-4b6f-9c1d-2e7a4b8d9f03',
        ts,
      }),
    );
  }
  db.close();
  return dbPath;
}

/** Run the flusher until `done` says stop; returns the delays it slept. */
async function runUntil(done: (sleeps: number[]) => boolean): Promise<number[]> {
  const sleeps: number[] = [];
  const spy = spyOn(Bun, 'sleep').mockImplementation((async (ms: number) => {
    sleeps.push(ms);
    if (done(sleeps)) {
      throw new StopLoop();
    }
  }) as typeof Bun.sleep);
  try {
    await runFlusher();
  } catch (err) {
    if (!(err instanceof StopLoop)) {
      throw err;
    }
  } finally {
    spy.mockRestore();
  }
  return sleeps;
}

function closedPort(): number {
  const s = Bun.serve({ fetch: () => new Response('x'), port: 0 });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe('flusher retry budget', () => {
  it('keeps every row through more than 15 minutes of network failure', async () => {
    const dbPath = seedQueue(25);
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${closedPort()}`;

    const sleeps = await runUntil((s) => sum(s) > 20 * 60_000);
    // 10 counted attempts used to be exhausted after ~13.5 min of this backoff.
    expect(sleeps.length).toBeGreaterThan(MAX_ATTEMPTS);

    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(25);
    expect(reader.drain(100).every((r) => r.attempts === 0)).toBe(true);
    reader.close();
  });

  it('does not count 429 toward the cap', async () => {
    const dbPath = seedQueue(3);
    const server = Bun.serve({ fetch: () => new Response('slow down', { status: 429 }), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runUntil((s) => s.length > MAX_ATTEMPTS + 2);
    } finally {
      server.stop(true);
    }
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(3);
    reader.close();
  });

  it('still drops a batch the server rejects MAX_ATTEMPTS times (5xx poison)', async () => {
    const dbPath = seedQueue(4);
    let posts = 0;
    const server = Bun.serve({
      fetch: () => {
        posts++;
        return new Response('boom', { status: 500 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runUntil((s) => s.length > MAX_ATTEMPTS + 5);
    } finally {
      server.stop(true);
    }
    expect(posts).toBe(MAX_ATTEMPTS);
    const db = new Database(dbPath);
    const left = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM events_queue').get();
    db.close();
    expect(left?.c).toBe(0);
  });
});

describe('flusher age expiry', () => {
  it('drops rows older than MAX_AGE_MS and keeps newer ones', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const old = new Date(now - MAX_AGE_MS - 60_000).toISOString();
    const fresh = new Date(now - MAX_AGE_MS + 60_000).toISOString();
    const dbPath = seedQueue(2, old);
    const db = new Database(dbPath);
    db.prepare('UPDATE events_queue SET ts = ? WHERE rowid = 2').run(fresh);
    db.close();

    const reader = openQueueReader(dbPath);
    expect(reader.dropExpired(now)).toBe(1);
    expect(reader.drain(10)).toHaveLength(1);
    expect(reader.drain(10)[0]?.ts).toBe(fresh);
    reader.close();
  });

  it('the loop discards an expired backlog without posting it', async () => {
    const dbPath = seedQueue(3, new Date(Date.now() - MAX_AGE_MS - 3_600_000).toISOString());
    let posts = 0;
    const server = Bun.serve({
      fetch: () => {
        posts++;
        return new Response('{}', { status: 200 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runUntil(() => true);
    } finally {
      server.stop(true);
    }
    expect(posts).toBe(0);
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(0);
    reader.close();
  });
});

describe('flusher 401', () => {
  it('stays alive, keeps the rows, and recovers when `aiot login` writes a fresh token', async () => {
    const dbPath = seedQueue(6);
    const auths: Array<string | null> = [];
    const server = Bun.serve({
      fetch: (req) => {
        const auth = req.headers.get('authorization');
        auths.push(auth);
        return auth === 'Bearer fresh-jwt'
          ? new Response('{}', { status: 200 })
          : new Response('expired', { status: 401 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'stale-jwt' }));

    let stateAfterFirst401: ReturnType<typeof getFlusherStatus> | undefined;
    try {
      await runUntil((s) => {
        if (s.length === 1) {
          // The loop is now waiting out the 401: it must still have the rows and
          // must have said why. Then the user re-authenticates.
          stateAfterFirst401 = getFlusherStatus();
          writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'fresh-jwt' }));
        }
        return s.length > 1;
      });
    } finally {
      server.stop(true);
    }

    expect(stateAfterFirst401?.lastError).toContain('Unauthorized (401)');
    expect(stateAfterFirst401?.queueDepth).toBe(6);
    expect(auths).toEqual(['Bearer stale-jwt', 'Bearer fresh-jwt']);
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(0);
    reader.close();
    expect(getFlusherStatus().lastError).toBeNull();
  });
});
