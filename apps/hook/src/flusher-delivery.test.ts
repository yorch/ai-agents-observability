import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFlusherStatus, runFlusher } from './flusher';
import * as identity from './lib/identity';
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
  let stopped = false;
  const spy = spyOn(Bun, 'sleep').mockImplementation((async (ms: number) => {
    // The loop's own per-iteration catch backs off after our sentinel, which
    // would sleep again; once stopped, just keep throwing it, unrecorded.
    if (stopped) {
      throw new StopLoop();
    }
    sleeps.push(ms);
    if (done(sleeps)) {
      stopped = true;
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
    let sleeps: number[] = [];
    try {
      sleeps = await runUntil((s) => {
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
    expect(sleeps[0]).toBe(60_000);
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(0);
    reader.close();
    expect(getFlusherStatus().lastError).toBeNull();
  });

  it('does not drain, enrich or POST again while the token is the rejected one', async () => {
    seedQueue(3);
    let posts = 0;
    const server = Bun.serve({
      fetch: () => {
        posts++;
        return new Response('expired', { status: 401 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    let sleeps: number[] = [];
    try {
      sleeps = await runUntil((s) => s.length >= 4);
    } finally {
      server.stop(true);
    }
    expect(posts).toBe(1);
    expect(sleeps).toEqual([60_000, 60_000, 60_000, 60_000]);
  });

  it('names AIOT_TOKEN in the error when the rejected token came from the environment', async () => {
    seedQueue(1);
    const server = Bun.serve({ fetch: () => new Response('no', { status: 401 }), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.AIOT_TOKEN = 'env-jwt';
    try {
      await runUntil(() => true);
    } finally {
      server.stop(true);
      delete process.env.AIOT_TOKEN;
    }
    expect(getFlusherStatus().lastError).toContain('AIOT_TOKEN');
  });
});

describe('flusher timeouts and robustness', () => {
  it('counts a TimeoutError toward the cap and drops the batch at it', async () => {
    const dbPath = seedQueue(3);
    let posts = 0;
    const server = Bun.serve({
      // Accepts the request and never answers: the server is reachable.
      fetch: () => {
        posts++;
        return new Promise<Response>(() => {});
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(40));
    try {
      await runUntil((s) => s.length > MAX_ATTEMPTS + 5);
    } finally {
      timeoutSpy.mockRestore();
      server.stop(true);
    }
    expect(posts).toBe(MAX_ATTEMPTS);
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(0);
    reader.close();
  });

  it('drops an undecodable row instead of wedging on it, and sends the rest', async () => {
    const dbPath = seedQueue(3);
    const db = new Database(dbPath);
    db.prepare("UPDATE events_queue SET payload_json = 'not json{' WHERE rowid = 2").run();
    db.close();
    const received: number[] = [];
    const server = Bun.serve({
      fetch: async (req) => {
        received.push(((await req.json()) as { events: unknown[] }).events.length);
        return new Response('{}', { status: 200 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runUntil((s) => s.length >= 1);
    } finally {
      server.stop(true);
    }
    expect(received).toEqual([2]);
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(0);
    reader.close();
  });

  it('survives an iteration that throws, backs off, and keeps delivering', async () => {
    const dbPath = seedQueue(2);
    const server = Bun.serve({ fetch: () => new Response('{}', { status: 200 }), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    const realLoad = identity.loadHookToken;
    let calls = 0;
    const spy = spyOn(identity, 'loadHookToken').mockImplementation(() => {
      if (calls++ === 0) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return realLoad();
    });
    let sleeps: number[] = [];
    try {
      sleeps = await runUntil((s) => s.length >= 2);
    } finally {
      spy.mockRestore();
      server.stop(true);
    }
    // First sleep is the backoff after the failed iteration, second the idle tick
    // after the successful delivery.
    expect(sleeps).toHaveLength(2);
    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(0);
    reader.close();
  });

  it('runs age expiry at most once a minute, not on every idle tick', async () => {
    const dbPath = seedQueue(0);
    const old = new Date(Date.now() - MAX_AGE_MS - 3_600_000).toISOString();
    process.env.INGEST_BASE_URL = 'http://127.0.0.1:1';
    await runUntil((s) => {
      if (s.length === 1) {
        // First tick (which did run expiry) is over; an expired row now arrives.
        seedExtra(dbPath, old);
      }
      return s.length >= 4;
    });
    const reader = openQueueReader(dbPath);
    // Three more 5s idle ticks happened; none of them may have re-run expiry.
    expect(reader.drain(10)).toHaveLength(1);
    reader.close();
  });

  it('pauses age expiry while there is no token', async () => {
    const dbPath = seedQueue(2, new Date(Date.now() - MAX_AGE_MS - 3_600_000).toISOString());
    rmSync(join(tmpHome, 'identity.json'));
    process.env.INGEST_BASE_URL = 'http://127.0.0.1:1';
    await runUntil((s) => s.length >= 2);
    const reader = openQueueReader(dbPath);
    expect(reader.drain(10)).toHaveLength(2);
    reader.close();
  });
});

function seedExtra(dbPath: string, ts: string): void {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO events_queue (event_id, ts, payload_json) VALUES (?, ?, ?)').run(
    '0192f3a0-7c1e-7b2a-9d4e-ffffffffffff',
    ts,
    JSON.stringify({ event_id: '0192f3a0-7c1e-7b2a-9d4e-ffffffffffff', ts }),
  );
  db.close();
}
