import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimDrainerSpawn,
  clearRejectedToken,
  clearSpawnClaim,
  currentHolder,
  isTokenRejected,
  LEASE_TTL_MS,
  readMode,
  recordRejectedToken,
  stopLeaseHolder,
  withLease,
  writeMode,
} from './lease';
import { openQueue } from './queue';

const FIXTURE = join(import.meta.dir, 'lease-holder.fixture.ts');
const STRESS_FIXTURE = join(import.meta.dir, 'lease-stress.fixture.ts');

let home: string;
let dbPath: string;
let savedAiotHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiot-lease-'));
  dbPath = join(home, 'queue.db');
  savedAiotHome = process.env.AIOT_HOME;
  process.env.AIOT_HOME = home;
  openQueue().close(); // create the schema
});

afterEach(() => {
  if (savedAiotHome === undefined) {
    delete process.env.AIOT_HOME;
  } else {
    process.env.AIOT_HOME = savedAiotHome;
  }
  rmSync(home, { force: true, recursive: true });
});

/** A real `bun` child that tries to take the lease. Resolves with its first stdout line. */
function contender(role: string, holdMs: number, startAt?: number) {
  const proc = Bun.spawn(
    ['bun', FIXTURE, dbPath, role, String(holdMs), ...(startAt ? [String(startAt)] : [])],
    { stderr: 'inherit', stdout: 'pipe' },
  );
  const firstLine = (async () => {
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value).trim();
  })();
  return { firstLine, proc };
}

function openDb(): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// (a) Lease tests use REAL child processes: an in-process test would share one
// SQLite connection and one event loop and could never exhibit a race.
describe('delivery lease across real processes', () => {
  // Mutual exclusion under sustained contention, across both kinds and a role that
  // needs both. A lease that is only ever raced once cannot show a window that opens
  // one acquisition in a few hundred: this caught a "clock stepped backwards" sanity
  // check that was tight enough to steal a lease another process had taken a moment
  // earlier (the contender reads its clock before waiting for the write lock).
  it('never lets two processes hold the same kind at once, over hundreds of contended acquisitions', async () => {
    const startAt = Date.now() + 2500;
    const roles = ['flusher', 'flusher', 'drain', 'drain', 'drain', 'shipper', 'shipper'];
    const procs = roles.map((role) =>
      Bun.spawn(['bun', STRESS_FIXTURE, dbPath, role, '150', String(startAt)], {
        stderr: 'inherit',
        stdout: 'pipe',
      }),
    );
    const out = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    // Every role made progress (nothing starved into never holding).
    expect(out.every((o) => /held=\d+/.test(o))).toBe(true);
    const db = openDb();
    const rows = db.query('SELECT kind, viol FROM crit ORDER BY kind').all();
    db.close();
    expect(rows).toEqual([
      { kind: 'events', viol: 0 },
      { kind: 'transcripts', viol: 0 },
    ]);
  }, 60_000);

  it('lets exactly one of many simultaneous processes win', async () => {
    const startAt = Date.now() + 1500;
    const racers = Array.from({ length: 8 }, () => contender('drain', 1200, startAt));
    const lines = await Promise.all(racers.map((r) => r.firstLine));
    await Promise.all(racers.map((r) => r.proc.exited));

    expect(lines.filter((l) => l.startsWith('HELD'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('BUSY'))).toHaveLength(7);
  });

  it('is visible to another process while held, and free once the holder exits cleanly', async () => {
    const holder = contender('flusher', 1500);
    const line = await holder.firstLine;
    expect(line).toStartWith('HELD');
    const pid = Number(line.split(' ')[1]);

    const db = openDb();
    const seen = currentHolder(db);
    expect(seen?.pid).toBe(pid);
    expect(seen?.role).toBe('flusher');
    expect((await withLease(db, 'flusher', async () => 'x')).held).toBe(false);

    await holder.proc.exited;
    expect(currentHolder(db)).toBeNull();
    expect((await withLease(db, 'flusher', async () => 'x')).held).toBe(true);
    db.close();
  });

  it('events and transcripts are separate leases: a shipper does not block the flusher, and a drainer then runs events only', async () => {
    const shipper = contender('shipper', 2500);
    expect(await shipper.firstLine).toStartWith('HELD');
    const db = openDb();
    // The flusher runs while the shipper holds `transcripts`...
    expect(await withLease(db, 'flusher', async () => 'flushed')).toEqual({
      held: true,
      value: 'flushed',
    });
    // ...a second shipper does not get in...
    expect((await withLease(db, 'shipper', async () => 'x')).held).toBe(false);
    // ...but a drainer does: it NEEDS `events` and merely WANTS `transcripts`, so it
    // delivers the events and leaves the transcripts to the shipper (it used to give
    // up the whole pass, stranding every hook that fired meanwhile).
    const drained = await withLease(db, 'drain', async (lease) => [...lease.kinds]);
    expect(drained).toEqual({ held: true, value: ['events'] });
    // And it needs `events`: with the flusher holding it, a drainer has nothing to do.
    await withLease(db, 'flusher', async () => {
      expect((await withLease(db, 'drain', async () => 'x')).held).toBe(false);
    });
    expect((await withLease(db, 'flusher', async () => 'again')).held).toBe(true);
    shipper.proc.kill('SIGKILL');
    await shipper.proc.exited;
    db.close();
  }, 20_000);

  it('a drainer that started without transcripts can add them once their holder is gone', async () => {
    const db = openDb();
    db.query(
      "UPDATE delivery_lease SET token = 'import-run', pid = 4242, role = 'import', started_at = ?, expires_at = ? WHERE kind = 'transcripts'",
    ).run(Date.now(), Date.now() + LEASE_TTL_MS);
    const result = await withLease(db, 'drain', async (lease) => {
      const before = [...lease.kinds];
      const addedWhileHeld = lease.tryAdd('transcripts');
      // The import finishes.
      db.query("UPDATE delivery_lease SET expires_at = 0 WHERE kind = 'transcripts'").run();
      const addedAfter = lease.tryAdd('transcripts');
      return {
        addedAfter,
        addedWhileHeld,
        after: [...lease.kinds],
        before,
        renewed: lease.check(),
      };
    });
    expect(result).toEqual({
      held: true,
      value: {
        addedAfter: true,
        addedWhileHeld: false,
        after: ['events', 'transcripts'],
        before: ['events'],
        renewed: true,
      },
    });
    db.close();
  });

  it('a holder that holds far past the TTL keeps the lease: the renewal timer works', async () => {
    const holder = contender('drain', 19_000);
    expect(await holder.firstLine).toStartWith('HELD');
    const started = Date.now();
    // Well past the 15 s TTL, with no one renewing but the holder's own timer.
    await Bun.sleep(LEASE_TTL_MS + 1500 - (Date.now() - started));
    const db = openDb();
    expect(currentHolder(db)).not.toBeNull();
    expect((await withLease(db, 'drain', async () => 'stolen')).held).toBe(false);
    db.close();
    holder.proc.kill('SIGKILL');
    await holder.proc.exited;
  }, 40_000);

  it('frees itself after the TTL when the holder is SIGKILLed — no unlock, no stale pid file', async () => {
    const holder = contender('drain', 60_000);
    expect(await holder.firstLine).toStartWith('HELD');
    const killedAt = Date.now();
    holder.proc.kill('SIGKILL');
    await holder.proc.exited;

    const db = openDb();
    // The dead process cannot release: it still looks held…
    expect(currentHolder(db)).not.toBeNull();
    expect((await withLease(db, 'drain', async () => 'x')).held).toBe(false);
    // …until its last renewal expires.
    const left = LEASE_TTL_MS + 500 - (Date.now() - killedAt);
    await Bun.sleep(Math.max(0, left));
    const taken = await withLease(db, 'drain', async () => 'recovered');
    expect(taken).toEqual({ held: true, value: 'recovered' });
    db.close();
  }, 30_000);

  it('a holder whose lease was taken learns it: check() is false and its signal aborts', async () => {
    const db = openDb();
    const result = await withLease(db, 'drain', async (lease) => {
      // Our (simulated) stall let the lease expire and someone else took it.
      db.query('UPDATE delivery_lease SET expires_at = 0').run();
      const other = openDb();
      const stolen = await withLease(other, 'import', async () => 'thief ran');
      expect(stolen.held).toBe(true);
      other.close();
      const kept = lease.check();
      return { aborted: lease.signal.aborted, kept, lost: lease.lost };
    });
    expect(result).toEqual({ held: true, value: { aborted: true, kept: false, lost: true } });
    db.close();
  });

  it('treats a lease claiming to outlive now + TTL as expired (a clock that stepped backwards)', async () => {
    const db = openDb();
    db.query(
      "UPDATE delivery_lease SET token = 'ghost', pid = 4242, role = 'drain', started_at = 1, expires_at = ? WHERE kind = 'events'",
    ).run(Date.now() + 10 * LEASE_TTL_MS);
    expect(currentHolder(db)).toBeNull();
    expect((await withLease(db, 'flusher', async () => 'ran')).held).toBe(true);
    db.close();
  });
});

describe('stopLeaseHolder', () => {
  it('refuses to signal a process that is not aiot', async () => {
    const holder = contender('drain', 20_000);
    expect(await holder.firstLine).toStartWith('HELD');
    const db = openDb();
    // The holder is a bare `bun` fixture, not an aiot binary.
    expect(await stopLeaseHolder(db)).toBe(false);
    expect(holder.proc.killed).toBe(false);
    holder.proc.kill('SIGKILL');
    await holder.proc.exited;
    db.close();
  });
});

describe('spawn claim', () => {
  it('is only ever granted in on-demand mode', () => {
    const db = openDb();
    expect(readMode(db)).toBe('resident');
    expect(claimDrainerSpawn(db)).toBe(false);
    writeMode(db, 'on-demand');
    expect(claimDrainerSpawn(db)).toBe(true);
    db.close();
  });

  it('is granted once per window, so a burst of Stop hooks starts one drainer', () => {
    const db = openDb();
    writeMode(db, 'on-demand');
    const now = Date.now();
    expect(claimDrainerSpawn(db, now)).toBe(true);
    expect(claimDrainerSpawn(db, now + 1)).toBe(false);
    expect(claimDrainerSpawn(db, now + 5_000)).toBe(false);
    expect(claimDrainerSpawn(db, now + 11_000)).toBe(true);
    db.close();
  });

  it('is refused while a drainer or the flusher is running — but NOT while only transcripts are held', async () => {
    const db = openDb();
    writeMode(db, 'on-demand');
    // A resident shipper / an import on `transcripts` alone: the spawned drainer can
    // still deliver the events (the probe: an 8 s import, Stop + SessionEnd, nothing
    // delivered afterwards).
    await withLease(db, 'import', async () => {
      expect(claimDrainerSpawn(db)).toBe(true);
    });
    clearSpawnClaim(db);
    await withLease(db, 'shipper', async () => {
      expect(claimDrainerSpawn(db)).toBe(true);
    });
    clearSpawnClaim(db);
    // The flusher on `events`: a drainer would find nothing to take.
    await withLease(db, 'flusher', async () => {
      expect(claimDrainerSpawn(db)).toBe(false);
    });
    // A drainer already running, whichever kinds it got.
    await withLease(db, 'drain', async () => {
      expect(claimDrainerSpawn(db)).toBe(false);
    });
    db.close();
  });

  it('is refused while a drainer holds its lease, and clearing the claim re-opens it', async () => {
    const db = openDb();
    writeMode(db, 'on-demand');
    expect(claimDrainerSpawn(db)).toBe(true);
    await withLease(db, 'drain', async () => {
      // The drainer is up: it clears the claim, and the held lease is what stops spawns.
      clearSpawnClaim(db);
      expect(claimDrainerSpawn(db)).toBe(false);
    });
    // Released with the claim cleared: the next terminal hook may spawn at once,
    // not after a 10 s timer.
    expect(claimDrainerSpawn(db)).toBe(true);
    db.close();
  });
});

describe('rejected token memory', () => {
  it('stores a fingerprint, never the token, and expires with the re-probe interval', () => {
    const db = openDb();
    const token = 'cct_super_secret_value';
    const t0 = Date.now();
    expect(isTokenRejected(db, token, t0)).toBe(false);
    recordRejectedToken(db, token, t0);
    expect(isTokenRejected(db, token, t0 + 60_000)).toBe(true);
    // A different token (after `aiot login`) is tried at once.
    expect(isTokenRejected(db, 'cct_replacement', t0 + 60_000)).toBe(false);
    // The same token is re-probed after 15 minutes.
    expect(isTokenRejected(db, token, t0 + 15 * 60_000 + 1)).toBe(false);
    const raw = JSON.stringify(db.query('SELECT * FROM drain_state').all());
    expect(raw).not.toContain(token);
    clearRejectedToken(db);
    expect(isTokenRejected(db, token, t0 + 1)).toBe(false);
    db.close();
  });
});
