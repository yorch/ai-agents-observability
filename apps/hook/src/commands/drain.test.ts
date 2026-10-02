import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newSessionId, writeTranscript } from '../lib/e2e-harness';
import {
  claimDrainerSpawn,
  LEASE_TTL_MS,
  readDrainStatus,
  recordRejectedToken,
  withLease,
  writeMode,
} from '../lib/lease';
import { openQueue } from '../lib/queue';
import { markShipFinal, writeShipMarker } from '../shipper';
import { drainPass, runDrain } from './drain';

// In-process tests of drainPass: the hard wall-clock cap (the compiled-binary suite
// covers every other way a drainer ends, but waiting 120 s for the real cap would
// make it a two-minute test) and what a drainer does when it LOSES its lease —
// which only a forced loss can show. Every fetch below is a REAL socket.

let home: string;
const saved: Record<string, string | undefined> = {};
let server: ReturnType<typeof Bun.serve> | null = null;

function setEnv(name: string, value: string): void {
  if (!(name in saved)) {
    saved[name] = process.env[name];
  }
  process.env[name] = value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiot-drain-'));
  setEnv('AIOT_HOME', home);
  setEnv('AIOT_CONFIG', join(home, 'config.json'));
  writeFileSync(join(home, 'identity.json'), JSON.stringify({ token: 'cct_test' }));
});

afterEach(() => {
  server?.stop(true);
  server = null;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    delete saved[name];
  }
  rmSync(home, { force: true, recursive: true });
});

const SESSION = '5f0c1d52-8a3e-4b6f-9c1d-2e7a4b8d9f03';

function enqueue(count: number, session = SESSION): void {
  const q = openQueue();
  for (let i = 0; i < count; i++) {
    const id = `0198f2c4-7a10-7b3e-9d41-${String(i).padStart(12, '0')}`;
    const ts = new Date(Date.now() - (count - i) * 1000).toISOString();
    q.enqueue({
      event_id: id,
      payload_json: JSON.stringify({
        agent_type: 'CLAUDE_CODE',
        event_id: id,
        event_type: 'Stop',
        session_context: { cwd: home },
        session_id: session,
        ts,
      }),
      ts,
    });
  }
  q.close();
}

/** Take a lease row away from whoever holds it, as a second process would after our stall. */
function steal(kind: 'events' | 'transcripts'): void {
  const q = openQueue();
  q.db
    .query(
      'UPDATE delivery_lease SET token = ?, pid = 999999, role = ?, started_at = ?, expires_at = ? WHERE kind = ?',
    )
    .run('thief', 'drain', Date.now(), Date.now() + LEASE_TTL_MS, kind);
  q.close();
}

describe('drainPass wall-clock cap', () => {
  it('gives up on a server that never answers, within the cap, and keeps the event', async () => {
    server = Bun.serve({
      async fetch() {
        await new Promise(() => {});
        return new Response('unreachable');
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
    enqueue(1);

    const started = Date.now();
    const report = await drainPass({ capMs: 1_500 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
    // An abort WE caused is a cap, not a transport failure — and it must not show up
    // in `aiot status` as "Network error".
    expect(report.stop).toBe('cap');
    expect(report.flushed).toBe(0);
    expect(report.remainingEvents).toBe(1);
    const statePath = join(home, 'flusher-state.json');
    if (existsSync(statePath)) {
      expect(readFileSync(statePath, 'utf8')).not.toContain('Network error');
    }
    // Hitting our own cap says nothing about the event: it is not charged an attempt,
    // and (unlike a real network error) not held back for later either.
    const q = openQueue();
    expect(q.db.query('SELECT attempts, next_attempt_at AS n FROM events_queue').get()).toEqual({
      attempts: 0,
      n: null,
    });
    // ...and a cap is not a failure to remember: the next drainer starts its backoff afresh.
    expect(readDrainStatus(q.db)).toMatchObject({ mode: 'resident' });
    expect(q.db.query('SELECT failure_streak AS n FROM drain_state').get()).toEqual({ n: 0 });
    q.close();
  });

  it('--wait for a lease that never frees is bounded by the cap too', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    steal('events');

    const started = Date.now();
    const report = await drainPass({ capMs: 1_500, wait: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.stop).toBe('busy');

    // Without --wait it does not even try: busy means exit now.
    const quick = Date.now();
    const again = await drainPass({ capMs: 1_500 });
    expect(Date.now() - quick).toBeLessThan(500);
    expect(again.stop).toBe('busy');
  });
});

describe('drainPass when it loses the lease', () => {
  it('stops sending event batches the moment it learns the lease is gone', async () => {
    let posts = 0;
    server = Bun.serve({
      fetch(req) {
        if (new URL(req.url).pathname === '/v1/events') {
          posts += 1;
          if (posts === 1) {
            // A second process takes over while our first batch is in flight.
            steal('events');
          }
          return Response.json({ accepted: 100, deduped: 0, rejected: 0 });
        }
        return new Response('nope', { status: 404 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
    enqueue(250); // three batches of up to 100

    const report = await drainPass({ capMs: 30_000 });

    expect(report.stop).toBe('lease_lost');
    // Exactly the batch that was already in flight: not one more.
    expect(posts).toBe(1);
    expect(report.remainingEvents).toBe(150);
  });

  it('stops between chunks of a transcript upload, keeping its progress for the next holder', async () => {
    const id = newSessionId();
    const transcript = join(home, 'projects', `${id}.jsonl`);
    writeTranscript(transcript, id, home, 2, 1200); // ~1.5 MB compressed: two chunks
    enqueue(1, id);
    writeShipMarker(id, transcript, false);

    const chunks: string[] = [];
    server = Bun.serve({
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/v1/events') {
          return Response.json({ accepted: 1, deduped: 0, rejected: 0 });
        }
        if (path === `/v1/transcripts/${id}`) {
          chunks.push(req.headers.get('content-range') ?? '');
          if (chunks.length === 1) {
            steal('transcripts');
          }
          return new Response('{}', { status: 202 });
        }
        return new Response('nope', { status: 404 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    const report = await drainPass({ capMs: 30_000 });

    expect(report.stop).toBe('lease_lost');
    // The first chunk was already out; the second must never be sent.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toStartWith('bytes 0-');
    expect(report.remainingTranscripts).toBe(1);
    // We stopped it; the transcript was not "refused", so the next holder is not made
    // to wait 60 s as it would be after a network error.
    const marker = JSON.parse(readFileSync(join(home, 'ship-queue', `${id}.json`), 'utf8'));
    expect(marker.next_attempt_at).toBeUndefined();
    expect(marker.attempts).toBeUndefined();
  });
});

describe('the spawn claim a hook left for this drainer', () => {
  function claim(): void {
    const q = openQueue();
    writeMode(q.db, 'on-demand');
    q.db.query('UPDATE drain_state SET spawn_claimed_until = ?').run(Date.now() + 10_000);
    q.close();
  }
  const claimed = (): number => {
    const q = openQueue();
    try {
      return (q.db.query('SELECT spawn_claimed_until AS c FROM drain_state').get() as { c: number })
        .c;
    } finally {
      q.close();
    }
  };

  it('is handed back when the drainer finds the lease busy', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    claim();
    steal('events');
    const report = await drainPass({ capMs: 1_500 });
    expect(report.stop).toBe('busy');
    // Otherwise every hook for the rest of the 10 s window is told "a drainer is on its way".
    expect(claimed()).toBe(0);
  });

  it('is handed back when the drainer dies before it can take the lease (SQLITE_BUSY)', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    claim();
    // Another process holds the write lock for longer than the 5 s busy timeout, and
    // lets go shortly after — long enough to make the lease UPDATE throw, short enough
    // that giving the claim back can still succeed.
    const holder = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, '..', 'lib', 'queue-lock-holder.ts'),
        join(home, 'queue.db'),
        '5400',
      ],
      { stderr: 'inherit', stdout: 'pipe' },
    );
    const reader = holder.stdout.getReader();
    await reader.read(); // "locked <ms>"
    reader.releaseLock();

    await expect(drainPass({ capMs: 20_000 })).rejects.toThrow();
    await holder.exited;
    expect(claimed()).toBe(0);
  }, 30_000);

  it('is kept by a drainer that DID take the lease until it clears it itself', async () => {
    // Control: the claim is the drainer's to clear once it holds the lease.
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    claim();
    await drainPass({ capMs: 1_500 });
    expect(claimed()).toBe(0);
  });
});

describe('a drainer that cannot get the transcripts lease', () => {
  it('still delivers the events and leaves the transcripts to the holder', async () => {
    let transcriptRequests = 0;
    server = Bun.serve({
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/v1/events') {
          return Response.json({ accepted: 3, deduped: 0, rejected: 0 });
        }
        transcriptRequests += 1;
        return new Response('{}', { status: 200 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
    const id = newSessionId();
    const transcript = join(home, 'projects', `${id}.jsonl`);
    writeTranscript(transcript, id, home, 2);
    enqueue(3, id);
    writeShipMarker(id, transcript, false);
    steal('transcripts'); // a shipper or an import is on them

    const report = await drainPass({ capMs: 10_000 });

    expect(report.flushed).toBe(3);
    expect(report.remainingEvents).toBe(0);
    expect(transcriptRequests).toBe(0);
    expect(report.remainingTranscripts).toBe(1);
    expect(report.stop).toBe('done');
  });
});

describe('what a clean drain claims', () => {
  it('is not recorded over rows that are only held back by a retry time', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    enqueue(1);
    const q = openQueue();
    q.db
      .query('UPDATE events_queue SET next_attempt_at = ?')
      .run(new Date(Date.now() + 3_600_000).toISOString());
    q.close();

    const report = await drainPass({ capMs: 5_000 });

    // Nothing was due, so the pass itself was clean; but `aiot status` must not read
    // "last drain: just now" over a queue that is stuck.
    expect(report.stop).toBe('done');
    expect(report.remainingEvents).toBe(1);
    const after = openQueue();
    expect(readDrainStatus(after.db).lastDrainOkAt).toBeNull();
    after.close();
  });

  it('IS recorded when nothing remains', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    const report = await drainPass({ capMs: 5_000 });
    expect(report.stop).toBe('done');
    const q = openQueue();
    expect(readDrainStatus(q.db).lastDrainOkAt).not.toBeNull();
    q.close();
  });
});

describe('retry backoff across drainers', () => {
  // A drainer is a new process every time, so the growth has to come from queue.db:
  // each pass that ends in a transport failure lengthens the retry time of the rows
  // that failed, and one that gets through starts it over. That only pushes back
  // rows that ALREADY failed; it does nothing about a hook adding a new due row and
  // spawning another drainer — that is the spawn HOLD, tested below.
  it('grows with consecutive failures and resets on success', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1'); // connection refused
    enqueue(1);
    const holdAfterPass = async (): Promise<number> => {
      const q = openQueue();
      q.db.query('UPDATE events_queue SET next_attempt_at = NULL').run(); // due again
      q.close();
      const before = Date.now();
      await drainPass({ capMs: 10_000 });
      const after = openQueue();
      const next = (
        after.db.query('SELECT next_attempt_at AS n FROM events_queue').get() as { n: string }
      ).n;
      after.close();
      return Date.parse(next) - before;
    };

    const first = await holdAfterPass(); // streak 0: about 1 s
    const second = await holdAfterPass(); // streak 1: about 2 s
    const third = await holdAfterPass(); // streak 2: about 4 s
    const fourth = await holdAfterPass(); // streak 3: about 8 s
    expect(first).toBeLessThan(1_800);
    expect(second).toBeGreaterThan(1_500);
    expect(third).toBeGreaterThan(3_100);
    expect(fourth).toBeGreaterThan(6_300);

    // The server comes back and the row goes through: the streak starts over.
    server = Bun.serve({
      fetch: () => Response.json({ accepted: 1, deduped: 0, rejected: 0 }),
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
    const q = openQueue();
    q.db.query('UPDATE events_queue SET next_attempt_at = NULL').run();
    q.close();
    const report = await drainPass({ capMs: 10_000 });
    expect(report.flushed).toBe(1);
    const after = openQueue();
    expect(after.db.query('SELECT failure_streak AS n FROM drain_state').get()).toEqual({ n: 0 });
    after.close();
  }, 30_000);
});

/** One more distinct event, like a hook adding a row each Stop. */
let nextEvent = 1_000;
function enqueueOne(session = SESSION): void {
  const q = openQueue();
  const id = `0198f2c4-7a10-7b3e-9d41-${String(nextEvent++).padStart(12, '0')}`;
  const ts = new Date().toISOString();
  q.enqueue({
    event_id: id,
    payload_json: JSON.stringify({
      agent_type: 'CLAUDE_CODE',
      event_id: id,
      event_type: 'Stop',
      session_context: { cwd: home },
      session_id: session,
      ts,
    }),
    ts,
  });
  q.close();
}

describe('recovery after an outage', () => {
  // The probe: eight passes against a refused port (a Stop adds a row each time), then
  // the server returns and one new event arrives. The recovered drainer used to send
  // that one event and end "done" with the rest still deferred ~2.5 minutes ahead —
  // for a later hook, i.e. the next SESSION if this was the end of one.
  it('one pass delivers the whole backlog, including rows deferred in the last backoff window', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    for (let i = 0; i < 8; i++) {
      enqueueOne();
      const down = await drainPass({ capMs: 10_000 });
      expect(down.stop).toBe('transport');
    }
    const q = openQueue();
    expect(q.db.query('SELECT COUNT(*) AS c FROM events_queue').get()).toEqual({ c: 8 });
    expect(
      (q.db.query('SELECT MAX(next_attempt_at) AS n FROM events_queue').get() as { n: string }).n >
        new Date(Date.now() + 60_000).toISOString(),
    ).toBe(true);
    q.close();

    const sent: number[] = [];
    server = Bun.serve({
      async fetch(req) {
        const body = (await req.json()) as { events: unknown[] };
        sent.push(body.events.length);
        return Response.json({ accepted: body.events.length, deduped: 0, rejected: 0 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
    enqueueOne(); // the event the recovering hook brings

    const up = await drainPass({ capMs: 20_000 });

    expect(up.stop).toBe('done');
    expect(up.flushed).toBe(9);
    expect(up.remainingEvents).toBe(0);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(9);
  }, 120_000);

  it('does the same for transcript markers held back by a failed upload', async () => {
    const id = newSessionId();
    const transcript = join(home, 'projects', `${id}.jsonl`);
    writeTranscript(transcript, id, home, 2);
    writeShipMarker(id, transcript, false);
    // Held back, as a failed upload leaves it...
    const markerPath = join(home, 'ship-queue', `${id}.json`);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    writeFileSync(
      markerPath,
      JSON.stringify({
        ...marker,
        next_attempt_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    // ...while an event goes through: the server is back.
    enqueueOne(id);
    let transcripts = 0;
    server = Bun.serve({
      fetch(req) {
        if (new URL(req.url).pathname === '/v1/events') {
          return Response.json({ accepted: 1, deduped: 0, rejected: 0 });
        }
        transcripts += 1;
        return new Response('{}', { status: 200 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    const report = await drainPass({ capMs: 20_000 });

    expect(report.flushed).toBe(1);
    expect(transcripts).toBe(1);
  });
});

describe('the spawn hold on a failing environment', () => {
  const holdUntil = (): number => {
    const q = openQueue();
    try {
      return (q.db.query('SELECT spawn_hold_until AS h FROM drain_state').get() as { h: number }).h;
    } finally {
      q.close();
    }
  };
  const onDemand = (): void => {
    const q = openQueue();
    writeMode(q.db, 'on-demand');
    q.close();
  };
  const canSpawn = (bypassHold = false): boolean => {
    const q = openQueue();
    try {
      return claimDrainerSpawn(q.db, Date.now(), { bypassHold });
    } finally {
      q.close();
    }
  };
  const clearClaim = (): void => {
    const q = openQueue();
    q.db.query('UPDATE drain_state SET spawn_claimed_until = 0').run();
    q.close();
  };

  it('a pass that fails keeps hooks from spawning more drainers, but not a SessionEnd', async () => {
    onDemand();
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    enqueueOne();

    const report = await drainPass({ capMs: 10_000 });

    expect(report.stop).toBe('transport');
    // At least the 30 s floor (the first backoff alone is ~1 s)...
    expect(holdUntil()).toBeGreaterThan(Date.now() + 25_000);
    // ...so the next Stops are not each given a drainer to fail again,
    expect(canSpawn()).toBe(false);
    // while a SessionEnd — the last chance for that session — still is.
    expect(canSpawn(true)).toBe(true);
  });

  it('a token that is missing or rejected holds spawns too', async () => {
    onDemand();
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    rmSync(join(home, 'identity.json'));
    enqueueOne();
    const report = await drainPass({ capMs: 10_000 });
    expect(report.stop).toBe('no_token');
    expect(canSpawn()).toBe(false);
  });

  it('a pass that gets through lifts the hold', async () => {
    onDemand();
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    enqueueOne();
    await drainPass({ capMs: 10_000 });
    expect(holdUntil()).toBeGreaterThan(Date.now());

    server = Bun.serve({
      fetch: () => Response.json({ accepted: 1, deduped: 0, rejected: 0 }),
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
    const q = openQueue();
    q.db.query('UPDATE events_queue SET next_attempt_at = NULL').run();
    q.close();
    const report = await drainPass({ capMs: 10_000 });

    expect(report.flushed).toBeGreaterThan(0);
    expect(holdUntil()).toBe(0);
    clearClaim();
    expect(canSpawn()).toBe(true);
  });

  it('an idle pass (everything held back by a retry time) neither resets the streak nor lifts the hold', async () => {
    onDemand();
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    enqueueOne();
    await drainPass({ capMs: 10_000 });
    const hold = holdUntil();
    const before = openQueue();
    const streak = (
      before.db.query('SELECT failure_streak AS n FROM drain_state').get() as { n: number }
    ).n;
    before.close();
    expect(streak).toBe(1);

    // A `drain --wait` or an import's post-pass while the row is still held back.
    const idle = await drainPass({ capMs: 5_000 });

    expect(idle.stop).toBe('done');
    expect(idle.remainingEvents).toBe(1);
    const after = openQueue();
    expect(after.db.query('SELECT failure_streak AS n FROM drain_state').get()).toEqual({ n: 1 });
    after.close();
    expect(holdUntil()).toBe(hold);
  }, 30_000);

  it('a batch of only undecodable rows is not a send: it resets neither the streak nor the hold', async () => {
    onDemand();
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    enqueueOne();
    await drainPass({ capMs: 10_000 }); // transport failure: streak 1, the row is held back
    const hold = holdUntil();
    const streak = () => {
      const q = openQueue();
      try {
        return (q.db.query('SELECT failure_streak AS n FROM drain_state').get() as { n: number }).n;
      } finally {
        q.close();
      }
    };
    expect(streak()).toBe(1);

    // A due row that can never be decoded, in front of the held-back good one.
    const q = openQueue();
    q.enqueue({
      event_id: '0198f2c4-7a10-7b3e-9d41-00000000c0de',
      payload_json: '{"agent_type":"CLAUDE_CODE","event_id":',
      ts: new Date(Date.now() - 1000).toISOString(),
    });
    q.close();

    const report = await drainPass({ capMs: 5_000 });

    expect(report.stop).toBe('done');
    expect(report.flushed).toBe(0); // dropping garbage is not a delivery
    expect(report.remainingEvents).toBe(1); // the corrupt row is gone, the good one is held
    expect(streak()).toBe(1);
    expect(holdUntil()).toBe(hold);
  }, 30_000);

  it('a --wait drainer reads the failure streak only once it holds the lease', async () => {
    onDemand();
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1'); // connection refused
    enqueueOne();
    // Another pass holds the lease; the waiter is queued behind it from the start.
    const other = openQueue();
    let finish: () => void = () => {};
    const otherPass = withLease(
      other.db,
      'drain',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const waiter = drainPass({ capMs: 20_000, wait: true });
    await Bun.sleep(300); // the waiter has started and found the lease taken

    // The pass ahead of it fails and records streak 5 before letting go. A waiter
    // that had read the streak up front would write 0 + 1 and lose all five.
    other.db.query('UPDATE drain_state SET failure_streak = 5 WHERE id = 1').run();
    finish();
    await otherPass;
    other.close();

    const report = await waiter;
    expect(report.stop).toBe('transport');
    const q = openQueue();
    expect(q.db.query('SELECT failure_streak AS n FROM drain_state').get()).toEqual({ n: 6 });
    q.close();
  }, 30_000);
});

describe('what a clean drain claims, marker side', () => {
  const lastOk = (): number | null => {
    const q = openQueue();
    try {
      return readDrainStatus(q.db).lastDrainOkAt;
    } finally {
      q.close();
    }
  };
  function mark(id: string, patch: Record<string, unknown>): string {
    const transcript = join(home, 'projects', `${id}.jsonl`);
    writeTranscript(transcript, id, home, 2);
    writeShipMarker(id, transcript, false);
    const path = join(home, 'ship-queue', `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }));
    return path;
  }

  it('a marker held back by a retry time blocks it', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    mark(newSessionId(), { next_attempt_at: new Date(Date.now() + 3_600_000).toISOString() });
    const report = await drainPass({ capMs: 5_000 });
    expect(report.stop).toBe('done');
    expect(lastOk()).toBeNull();
  });

  it('a marker that only waits for the 10-minute transcript cadence does not', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    mark(newSessionId(), { last_shipped_at: new Date(Date.now() - 60_000).toISOString() });
    const report = await drainPass({ capMs: 5_000 });
    expect(report.stop).toBe('done');
    expect(report.remainingTranscripts).toBe(1); // still shown as pending in `aiot status`
    expect(lastOk()).not.toBeNull();
  });

  it('a FINAL marker left alone because another process holds the transcripts blocks it', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    const id = newSessionId();
    mark(id, {});
    markShipFinal(id);
    steal('transcripts');
    const report = await drainPass({ capMs: 5_000 });
    expect(report.stop).toBe('done');
    expect(lastOk()).toBeNull();
    expect(report.remainingTranscripts).toBe(1);
  });
});

describe('`aiot drain --wait` output', () => {
  async function waitOutput(): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    };
    try {
      const code = await runDrain(['--wait']);
      return { code, out: chunks.join('') };
    } finally {
      process.stdout.write = orig;
    }
  }

  function rejectToken(token: string): void {
    const q = openQueue();
    recordRejectedToken(q.db, token);
    q.close();
  }

  it('tells an AIOT_TOKEN user to replace it, since `aiot login` cannot override it', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    setEnv('AIOT_TOKEN', 'cct_from_env');
    rejectToken('cct_from_env');

    const { code, out } = await waitOutput();

    expect(code).toBe(1);
    expect(out).toContain('AIOT_TOKEN is set and was rejected — replace it');
    expect(out).not.toMatch(/result:\s+token rejected — run `aiot login`/);
  });

  it('still points a login-token user at `aiot login`', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    rejectToken('cct_test');

    const { code, out } = await waitOutput();

    expect(code).toBe(1);
    expect(out).toMatch(/result:\s+token rejected\. Run `aiot login` to re-authenticate/);
  });

  it('does not print `complete` beside exit 1 when rows are waiting out a retry delay', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');
    enqueue(2);
    const q = openQueue();
    q.db
      .query('UPDATE events_queue SET next_attempt_at = ?')
      .run(new Date(Date.now() + 3_600_000).toISOString());
    q.close();

    const { code, out } = await waitOutput();

    expect(code).toBe(1);
    expect(out).toMatch(/events remaining:\s+2/);
    expect(out).toMatch(
      /result:\s+incomplete — 2 events still queued.*waiting out a retry delay or held by another delivery process/,
    );
    expect(out).not.toContain('complete\n');
  });

  it('still says `complete` with exit 0 when nothing remains', async () => {
    setEnv('INGEST_BASE_URL', 'http://127.0.0.1:1');

    const { code, out } = await waitOutput();

    expect(code).toBe(0);
    expect(out).toMatch(/result:\s+complete/);
  });
});
