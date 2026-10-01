import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from './queue';
import { openQueueReader } from './queue-reader';

// bun:sqlite's busy_timeout defaults to 0, so a writer that met another writer
// failed instantly with SQLITE_BUSY: the hook dropped the event, and in the
// flusher a throw from drain/dropExpired (the only reader calls outside its
// inner try) escaped the loop. The competing writer is a separate process
// holding the lock; each test also asserts the call returned only after the
// holder's own lock-acquired timestamp plus the hold, so it cannot pass without
// having waited on the lock.

// The hook's busy_timeout is 100ms, so its hold must be shorter than that; the
// flusher's is 5000ms, so its hold can be long enough to be insensitive to
// scheduling jitter.
const HOOK_HOLD_MS = 70;
const READER_HOLD_MS = 300;
const CLOCK_SLACK_MS = 5;
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

async function holdWriteLock(
  dbPath: string,
  holdMs: number,
): Promise<{ released: Promise<number>; releaseAt: number }> {
  const proc = Bun.spawn([process.execPath, HOLDER, dbPath, String(holdMs)], { stdout: 'pipe' });
  const out = proc.stdout.getReader();
  const line = new TextDecoder().decode((await out.read()).value); // `locked <epoch ms>`
  out.releaseLock();
  return { releaseAt: Number(line.split(' ')[1]) + holdMs, released: proc.exited };
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
    const { released, releaseAt } = await holdWriteLock(`${tmpHome}/queue.db`, HOOK_HOLD_MS);

    expect(() =>
      q.enqueue({
        event_id: EVENT.event_id,
        payload_json: JSON.stringify(EVENT),
        ts: new Date().toISOString(),
      }),
    ).not.toThrow();
    expect(Date.now()).toBeGreaterThanOrEqual(releaseAt - CLOCK_SLACK_MS);
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
    const { released, releaseAt } = await holdWriteLock(`${tmpHome}/queue.db`, READER_HOLD_MS);

    expect(() => reader.markAttempt([EVENT.event_id])).not.toThrow();
    expect(Date.now()).toBeGreaterThanOrEqual(releaseAt - CLOCK_SLACK_MS);
    reader.close();
    await released;
  });
});
