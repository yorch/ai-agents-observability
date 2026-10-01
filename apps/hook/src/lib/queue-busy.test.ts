import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from './queue';
import { openQueueReader } from './queue-reader';

// bun:sqlite's busy_timeout defaults to 0, so a writer that met another writer
// failed instantly with SQLITE_BUSY: the hook dropped the event, and the flusher
// loop (which has no try/catch around the reader) crashed. The competing writer
// is a separate process holding the lock for 60ms.

const HOLDER = join(import.meta.dir, 'queue-lock-holder.ts');

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-busy-test-'));
  process.env.AIOT_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
});

async function holdWriteLock(dbPath: string): Promise<{ released: Promise<number> }> {
  const proc = Bun.spawn([process.execPath, HOLDER, dbPath, '60'], { stdout: 'pipe' });
  const out = proc.stdout.getReader();
  await out.read(); // printed once the holder owns the write lock
  out.releaseLock();
  return { released: proc.exited };
}

const EVENT = {
  agent_type: 'claude-code',
  event_id: '0192f3a0-7c1e-7b2a-9d4e-000000000002',
  event_type: 'PostToolUse',
  session_id: '5f0c1d52-8a3e-4b6f-9c1d-2e7a4b8d9f03',
};

describe('write contention', () => {
  it('hook enqueue waits out a competing write instead of failing with SQLITE_BUSY', async () => {
    const q = openQueue(); // creates the schema
    const { released } = await holdWriteLock(`${tmpHome}/queue.db`);

    expect(() =>
      q.enqueue({
        event_id: EVENT.event_id,
        payload_json: JSON.stringify(EVENT),
        ts: new Date().toISOString(),
      }),
    ).not.toThrow();
    q.close();
    await released;

    const db = new Database(`${tmpHome}/queue.db`);
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM events_queue').get()?.c).toBe(1);
    db.close();
  });

  it('flusher-side writes wait out a competing write instead of throwing', async () => {
    const q = openQueue();
    q.enqueue({
      event_id: EVENT.event_id,
      payload_json: JSON.stringify(EVENT),
      ts: new Date().toISOString(),
    });
    q.close();

    const reader = openQueueReader(`${tmpHome}/queue.db`);
    const { released } = await holdWriteLock(`${tmpHome}/queue.db`);

    expect(() => reader.markAttempt([EVENT.event_id])).not.toThrow();
    reader.close();
    await released;
  });
});
