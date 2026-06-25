import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueueReader } from './lib/queue-reader';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQueueDb(dbPath: string, rowCount: number): void {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events_queue (
      event_id     TEXT PRIMARY KEY,
      ts           TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempted_at TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO events_queue (event_id, ts, payload_json) VALUES (?, ?, ?)',
  );
  for (let i = 0; i < rowCount; i++) {
    const id = `event-${String(i).padStart(6, '0')}`;
    insert.run(id, new Date().toISOString(), JSON.stringify({ event_id: id, event_type: 'Stop' }));
  }
  db.close();
}

type ReceivedBatch = { events: unknown[]; count: number };

/**
 * Spin up a mock HTTP server that handles POST /v1/events.
 * `responses` is a queue of status codes to return in order (last one repeats).
 */
function startMockServer(responses: number[]): {
  port: number;
  received: ReceivedBatch[];
  server: ReturnType<typeof Bun.serve>;
} {
  const received: ReceivedBatch[] = [];
  let callIndex = 0;

  const server = Bun.serve({
    fetch(req) {
      const status = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;

      if (req.method === 'POST' && new URL(req.url).pathname === '/v1/events') {
        return req
          .json()
          .then((body: { events: unknown[] }) => {
            received.push({ count: body.events?.length ?? 0, events: body.events ?? [] });
            return new Response(JSON.stringify({ ok: true }), { status });
          })
          .catch(() => new Response('bad request', { status: 400 }));
      }
      return new Response('not found', { status: 404 });
    },
    port: 0, // random port
  });

  return { port: server.port, received, server };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'claude-tel-flusher-test-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.CLAUDE_TELEMETRY_HOME;
  delete process.env.INGEST_BASE_URL;
});

describe('QueueReader', () => {
  it('drain returns up to limit rows where attempts < 10', () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 150);

    const reader = openQueueReader(dbPath);
    const rows = reader.drain(100);
    reader.close();

    expect(rows.length).toBe(100);
  });

  it('depth counts rows where attempts < 10', () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 150);

    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(150);
    reader.close();
  });

  it('markAttempt increments attempts counter', () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 5);

    const reader = openQueueReader(dbPath);
    const rows = reader.drain(5);
    const ids = rows.map((r) => r.event_id);
    reader.markAttempt(ids);
    const updated = reader.drain(5);
    reader.close();

    for (const row of updated) {
      expect(row.attempts).toBe(1);
    }
  });

  it('delete removes rows from the queue', () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 10);

    const reader = openQueueReader(dbPath);
    const rows = reader.drain(5);
    reader.delete(rows.map((r) => r.event_id));
    expect(reader.depth()).toBe(5);
    reader.close();
  });

  it('dropAbandoned removes rows that hit the attempt cap and keeps others', () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 3);

    const db = new Database(dbPath);
    // Force one row to the cap (10) and leave the rest under it.
    db.prepare('UPDATE events_queue SET attempts = 10 WHERE event_id = ?').run('event-000000');
    db.close();

    const reader = openQueueReader(dbPath);
    // Capped row is excluded from depth but still present in the DB.
    expect(reader.depth()).toBe(2);
    const dropped = reader.dropAbandoned();
    expect(dropped).toBe(1);
    // Second call is a no-op once abandoned rows are gone.
    expect(reader.dropAbandoned()).toBe(0);
    expect(reader.depth()).toBe(2);
    reader.close();
  });
});

describe('flusher POST batches', () => {
  it('sends 2 batches of 100 for 150 rows and drains queue on 200 response', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 150);

    const { port, received, server } = startMockServer([200]);

    try {
      process.env.INGEST_BASE_URL = `http://localhost:${port}`;

      // Write a fake identity token
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(tmpHome, { recursive: true });
      writeFileSync(
        join(tmpHome, 'identity.json'),
        JSON.stringify({ token: 'test-jwt-token' }),
        'utf8',
      );

      // Directly use the queue reader + fetch to simulate 2 flusher iterations
      const INGEST_BASE_URL = `http://localhost:${port}`;
      const reader = openQueueReader(dbPath);

      for (let iteration = 0; iteration < 2; iteration++) {
        const rows = reader.drain(100);
        if (rows.length === 0) {
          break;
        }

        const events = rows.map((r) => JSON.parse(r.payload_json) as unknown);
        const body = JSON.stringify({ events, session_context: null });

        const res = await fetch(`${INGEST_BASE_URL}/v1/events`, {
          body,
          headers: {
            Authorization: 'Bearer test-jwt-token',
            'Content-Type': 'application/json',
          },
          method: 'POST',
        });

        if (res.status >= 200 && res.status < 300) {
          reader.delete(rows.map((r) => r.event_id));
        }
      }

      const finalDepth = reader.depth();
      reader.close();

      expect(received.length).toBe(2);
      expect(received[0].count).toBe(100);
      expect(received[1].count).toBe(50);
      expect(finalDepth).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  it('retries rows on 5xx and deletes on eventual 200', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 10);

    // Server returns 500, 500, then 200
    const statusCodes = [500, 500, 200];
    const { port, received, server } = startMockServer(statusCodes);

    try {
      const INGEST_BASE_URL = `http://localhost:${port}`;

      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(tmpHome, 'identity.json'),
        JSON.stringify({ token: 'test-jwt-token' }),
        'utf8',
      );

      const reader = openQueueReader(dbPath);
      const rows = reader.drain(100);
      const ids = rows.map((r) => r.event_id);
      const events = rows.map((r) => JSON.parse(r.payload_json) as unknown);

      // Attempt 1: 500
      const body = JSON.stringify({ events, session_context: null });
      const res1 = await fetch(`${INGEST_BASE_URL}/v1/events`, {
        body,
        headers: { Authorization: 'Bearer test-jwt-token', 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(res1.status).toBe(500);
      reader.markAttempt(ids);
      expect(reader.drain(100)[0].attempts).toBe(1);

      // Attempt 2: 500 again
      const res2 = await fetch(`${INGEST_BASE_URL}/v1/events`, {
        body,
        headers: { Authorization: 'Bearer test-jwt-token', 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(res2.status).toBe(500);
      reader.markAttempt(ids);
      expect(reader.drain(100)[0].attempts).toBe(2);

      // Attempt 3: 200
      const res3 = await fetch(`${INGEST_BASE_URL}/v1/events`, {
        body,
        headers: { Authorization: 'Bearer test-jwt-token', 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(res3.status).toBe(200);
      reader.delete(ids);
      expect(reader.depth()).toBe(0);

      reader.close();

      // Server received 3 POST requests
      expect(received.length).toBe(3);
      // All 3 requests had the same 10 events
      for (const batch of received) {
        expect(batch.count).toBe(10);
      }
    } finally {
      server.stop(true);
    }
  });
});
