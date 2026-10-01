import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from './queue';
import { openQueueReader } from './queue-reader';

let home: string;
let dbPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiot-schema-'));
  dbPath = join(home, 'queue.db');
  process.env.AIOT_HOME = home;
});

afterEach(() => {
  delete process.env.AIOT_HOME;
  rmSync(home, { force: true, recursive: true });
});

// The queue.db every existing install already has: no retry-time or enrichment
// columns, no drain_state table, user_version 0.
function writeLegacyQueue(): void {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE events_queue (
      event_id     TEXT PRIMARY KEY,
      ts           TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempted_at TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX events_queue_ts_idx ON events_queue (ts);
  `);
  db.query(
    'INSERT INTO events_queue (event_id, ts, payload_json, attempts) VALUES (?, ?, ?, ?)',
  ).run(
    '0198f2c4-7a10-7b3e-9d41-5c2a6e1f0b01',
    '2026-09-30T10:00:00.000Z',
    '{"event_type":"Stop"}',
    3,
  );
  db.close();
}

describe('queue schema migration', () => {
  it('upgrades a legacy queue in place without losing queued rows', () => {
    writeLegacyQueue();

    const reader = openQueueReader(dbPath);
    const rows = reader.drain(10);
    reader.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 3, enriched: 0 });
    const db = new Database(dbPath);
    const cols = db
      .query<{ name: string }, []>('PRAGMA table_info(events_queue)')
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['next_attempt_at', 'enriched']));
    expect(db.query('SELECT mode FROM drain_state WHERE id = 1').get()).toEqual({
      mode: 'resident',
    });
    db.close();
  });

  it('is idempotent, and the hook path (openQueue) upgrades a legacy queue too', () => {
    writeLegacyQueue();
    openQueue().close();
    openQueue().close();
    openQueueReader(dbPath).close();
    const db = new Database(dbPath);
    expect(db.query('SELECT COUNT(*) AS c FROM events_queue').get()).toEqual({ c: 1 });
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    db.close();
  });
});

describe('concurrent one-time upgrade', () => {
  it('several hooks meeting a legacy queue at once all open it — none throws, no event is lost', async () => {
    writeLegacyQueue();
    const startAt = Date.now() + 1200;
    const script = `
      import { openQueue } from '${join(import.meta.dir, 'queue')}';
      while (Date.now() < ${startAt}) {}
      try {
        const q = openQueue();
        q.enqueue({ event_id: crypto.randomUUID(), payload_json: '{}', ts: new Date().toISOString() });
        q.close();
        console.log('OK');
      } catch (e) { console.log('FAIL ' + e.message); }
    `;
    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn(['bun', '-e', script], {
        env: { ...process.env, AIOT_HOME: home },
        stderr: 'inherit',
        stdout: 'pipe',
      }),
    );
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    expect(outs.map((o) => o.trim())).toEqual(Array(6).fill('OK'));
    const db = new Database(dbPath);
    // The legacy row plus one per hook.
    expect(db.query('SELECT COUNT(*) AS c FROM events_queue').get()).toEqual({ c: 7 });
    db.close();
  }, 30_000);
});

describe('on-disk retry state', () => {
  const ID = '0198f2c4-7a10-7b3e-9d41-5c2a6e1f0b02';

  it('a deferred row is invisible to the next process until its retry time', () => {
    const q = openQueue();
    q.enqueue({ event_id: ID, payload_json: '{}', ts: '2026-09-30T10:00:00.000Z' });
    q.close();

    const first = openQueueReader(dbPath);
    first.defer([ID], Date.now() + 60_000);
    first.close();

    // A brand-new process-equivalent: fresh connection, no memory of the backoff.
    const second = openQueueReader(dbPath);
    expect(second.drain(10)).toHaveLength(0);
    // Still counted as owed, and still the oldest — a stuck queue stays visible.
    expect(second.depth()).toBe(1);
    expect(second.oldestTs()).toBe('2026-09-30T10:00:00.000Z');
    second.defer([ID], Date.now() - 1);
    expect(second.drain(10)).toHaveLength(1);
    second.close();
  });
});
