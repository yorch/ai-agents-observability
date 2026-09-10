import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inlineDrain, postEventBatch } from './flusher';
import { getShipMode, updateCliConfig } from './lib/config';
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

function startMockServer(responses: number[]): {
  port: number;
  received: { count: number }[];
  server: ReturnType<typeof Bun.serve>;
} {
  const received: { count: number }[] = [];
  let callIndex = 0;

  const server = Bun.serve({
    fetch(req) {
      const status = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;

      if (req.method === 'POST' && new URL(req.url).pathname === '/v1/events') {
        return req
          .json()
          .then((raw: unknown) => {
            const body = raw as { events: unknown[] };
            received.push({ count: body.events?.length ?? 0 });
            return new Response(JSON.stringify({ ok: true }), { status: status ?? 200 });
          })
          .catch(() => new Response('bad request', { status: 400 }));
      }
      return new Response('not found', { status: 404 });
    },
    port: 0,
  });

  return { port: server.port ?? 0, received, server };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-inline-test-'));
  process.env.AIOT_HOME = tmpHome;
  process.env.AIOT_CONFIG = join(tmpHome, 'config.json');
  delete process.env.AIOT_INLINE_TIMEOUT_MS;
  delete process.env.INGEST_BASE_URL;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.AIOT_CONFIG;
  delete process.env.AIOT_INLINE_TIMEOUT_MS;
  delete process.env.INGEST_BASE_URL;
});

function writeIdentity(): void {
  writeFileSync(
    join(tmpHome, 'identity.json'),
    JSON.stringify({ token: 'test-jwt-token' }),
    'utf8',
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('inlineDrain — successful POST drains the queue', () => {
  it('deletes events from the queue on a 200 response', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 5);
    writeIdentity();

    const { port, server } = startMockServer([200]);
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      await inlineDrain(5000);

      const reader = openQueueReader(dbPath);
      expect(reader.depth()).toBe(0);
      reader.close();
    } finally {
      server.stop(true);
    }
  });

  it('writes flusher state with a successful flush timestamp', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 3);
    writeIdentity();

    const { port, server } = startMockServer([200]);
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      await inlineDrain(5000);

      const state = JSON.parse(readFileSync(join(tmpHome, 'flusher-state.json'), 'utf8')) as {
        lastError: null;
        lastFlushAt: string;
        queueDepth: number;
      };
      expect(state.lastError).toBeNull();
      expect(state.lastFlushAt).toBeTruthy();
      expect(state.queueDepth).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

describe('inlineDrain — POST failure leaves events in queue', () => {
  it('leaves events in the queue on a 500 response (no data loss)', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 5);
    writeIdentity();

    const { port, server } = startMockServer([500]);
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      await inlineDrain(5000);

      const reader = openQueueReader(dbPath);
      // Events stay in the queue — inline mode does NOT markAttempt.
      expect(reader.depth()).toBe(5);
      // Attempts should still be 0 — no markAttempt on failure.
      const rows = reader.drain(5);
      for (const row of rows) {
        expect(row.attempts).toBe(0);
      }
      reader.close();
    } finally {
      server.stop(true);
    }
  });

  it('leaves events in the queue on network error', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 3);
    writeIdentity();

    // Point at a port that refuses connections
    process.env.INGEST_BASE_URL = 'http://localhost:1';

    await inlineDrain(5000);

    const reader = openQueueReader(dbPath);
    expect(reader.depth()).toBe(3);
    reader.close();
  });
});

describe('inlineDrain — hard timeout', () => {
  it('abandons the drain when the timeout fires (events stay in queue)', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 5);
    writeIdentity();

    // Server that hangs forever (never responds)
    const server = Bun.serve({
      fetch() {
        // Never returns — the abort signal will fire
        return new Promise(() => {});
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://localhost:${server.port}`;

    try {
      // 200ms budget — the server hangs, so the abort should fire
      const start = Date.now();
      await inlineDrain(200);
      const elapsed = Date.now() - start;

      // Should have returned within a reasonable margin of the timeout
      expect(elapsed).toBeLessThan(2000);

      // Events stay in the queue
      const reader = openQueueReader(dbPath);
      expect(reader.depth()).toBe(5);
      reader.close();
    } finally {
      server.stop(true);
    }
  });

  it('respects AIOT_INLINE_TIMEOUT_MS env var', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 3);
    writeIdentity();

    const server = Bun.serve({
      fetch() {
        return new Promise(() => {});
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://localhost:${server.port}`;
    process.env.AIOT_INLINE_TIMEOUT_MS = '150';

    try {
      const start = Date.now();
      await inlineDrain();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2000);

      const reader = openQueueReader(dbPath);
      expect(reader.depth()).toBe(3);
      reader.close();
    } finally {
      server.stop(true);
    }
  });
});

describe('postEventBatch — shared drain function', () => {
  it('returns ok=true with count=0 when queue is empty', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 0);

    const reader = openQueueReader(dbPath);
    const result = await postEventBatch(reader, 'jwt', 'http://localhost:4000', {
      batchSize: 50,
      timeoutMs: 5000,
    });
    reader.close();

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });

  it('deletes rows on success and returns eventIds', async () => {
    const dbPath = join(tmpHome, 'queue.db');
    makeQueueDb(dbPath, 3);

    const { port, server } = startMockServer([200]);
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const reader = openQueueReader(dbPath);
      const result = await postEventBatch(reader, 'jwt', `http://localhost:${port}`, {
        batchSize: 50,
        timeoutMs: 5000,
      });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(3);
      expect(result.eventIds).toHaveLength(3);
      expect(reader.depth()).toBe(0);
      reader.close();
    } finally {
      server.stop(true);
    }
  });
});

describe('ship-mode config', () => {
  it('defaults to daemon when not set', () => {
    expect(getShipMode()).toBe('daemon');
  });

  it('reads inline mode from persisted config', () => {
    updateCliConfig({ ship_mode: 'inline' });
    expect(getShipMode()).toBe('inline');
  });

  it('reads daemon mode from persisted config', () => {
    updateCliConfig({ ship_mode: 'daemon' });
    expect(getShipMode()).toBe('daemon');
  });

  it('unsetting ship-mode reverts to daemon default', () => {
    updateCliConfig({ ship_mode: 'inline' });
    updateCliConfig({ ship_mode: null });
    expect(getShipMode()).toBe('daemon');
  });

  it('config set ship-mode inline persists the value', () => {
    const { runConfig } = require('./commands/config');
    const exit = runConfig(['config', 'set', 'ship-mode', 'inline']);
    expect(exit).toBe(0);
    expect(getShipMode()).toBe('inline');
  });

  it('config set ship-mode rejects invalid values', () => {
    const { runConfig } = require('./commands/config');
    const exit = runConfig(['config', 'set', 'ship-mode', 'bogus']);
    expect(exit).toBe(1);
    expect(getShipMode()).toBe('daemon');
  });

  it('config show displays ship-mode', () => {
    updateCliConfig({ ship_mode: 'inline' });
    const origWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const { runConfig } = require('./commands/config');
      runConfig(['config', 'show']);
    } finally {
      process.stdout.write = origWrite;
    }
    const output = chunks.join('');
    expect(output).toContain('ship_mode=inline');
  });
});
