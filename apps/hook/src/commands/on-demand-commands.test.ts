import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDrainStatus, recordDrainOk, writeMode } from '../lib/lease';
import { openQueue } from '../lib/queue';
import { runPurge } from './purge';
import { runStatus } from './status';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-ondemand-cmd-'));
  process.env.AIOT_HOME = tmpHome;
  process.env.AIOT_CONFIG = join(tmpHome, 'config.json');
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.AIOT_CONFIG;
});

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  };
  process.stderr.write = (c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return chunks.join('');
}

/** A queue row as the hook writes it, aged `ageMs` into the past. */
function enqueueAged(ageMs: number): string {
  const ts = new Date(Date.now() - ageMs).toISOString();
  const q = openQueue();
  q.enqueue({ event_id: '0198f2c4-7a10-7b3e-9d41-5c2a6e1f0b77', payload_json: '{}', ts });
  writeMode(q.db, 'on-demand');
  q.close();
  return ts;
}

const STALE_HEARTBEAT = {
  lastError: null,
  lastFlushAt: null,
  lastHeartbeatAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  queueDepth: 1,
};

describe('status in on-demand mode', () => {
  it('does not raise the stale-heartbeat warning, and reports what matters instead', async () => {
    const ts = enqueueAged(3 * 3_600_000);
    writeFileSync(join(tmpHome, 'flusher-state.json'), JSON.stringify(STALE_HEARTBEAT));

    const out = await capture(() => runStatus());

    expect(out).not.toContain('WARNING');
    expect(out).not.toMatch(/heartbeat/i);
    expect(out).toMatch(/mode:\s+on-demand/);
    expect(out).toMatch(/queue depth:\s+1/);
    // A stuck queue stays visible: the age of the oldest undelivered row.
    expect(out).toMatch(/oldest queued:\s+3h old/);
    expect(out).toContain(ts);
    expect(out).toMatch(/last drain:\s+never/);
    expect(out).toMatch(/drain lease:\s+none/);
  });

  it('shows the time of the last clean drain', async () => {
    enqueueAged(1000);
    const q = openQueue();
    recordDrainOk(q.db, Date.parse('2026-09-30T12:00:00.000Z'));
    expect(readDrainStatus(q.db).lastDrainOkAt).toBe(Date.parse('2026-09-30T12:00:00.000Z'));
    q.close();

    const out = await capture(() => runStatus());
    expect(out).toContain('2026-09-30T12:00:00.000Z');
  });

  it('resident mode still raises the stale-heartbeat warning', async () => {
    const q = openQueue();
    q.enqueue({
      event_id: '0198f2c4-7a10-7b3e-9d41-5c2a6e1f0b78',
      payload_json: '{}',
      ts: new Date().toISOString(),
    });
    q.close();
    writeFileSync(join(tmpHome, 'flusher-state.json'), JSON.stringify(STALE_HEARTBEAT));

    const out = await capture(() => runStatus());
    expect(out).toContain('WARNING: flusher heartbeat');
    expect(out).toMatch(/mode:\s+resident/);
  });
});

describe('purge-local in on-demand mode', () => {
  it('removes the queue and its -wal/-shm, but keeps the install mode', async () => {
    enqueueAged(1000);
    const out = await capture(() => runPurge(['--yes']));

    expect(out).toContain('kept: install mode (on-demand)');
    // The recreated queue holds the mode and none of the old rows.
    const q = openQueue();
    expect(readDrainStatus(q.db).mode).toBe('on-demand');
    expect(q.db.query('SELECT COUNT(*) AS c FROM events_queue').get()).toEqual({ c: 0 });
    q.close();
  });

  it('leaves nothing behind for a resident install', async () => {
    const q = openQueue();
    q.close();
    await capture(() => runPurge(['--yes']));
    expect(existsSync(join(tmpHome, 'queue.db'))).toBe(false);
    expect(existsSync(join(tmpHome, 'queue.db-wal'))).toBe(false);
    expect(existsSync(join(tmpHome, 'queue.db-shm'))).toBe(false);
  });
});
