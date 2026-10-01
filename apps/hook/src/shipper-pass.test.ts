import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newSessionId, writeTranscript } from './lib/e2e-harness';
import {
  clearMarkerDeferrals,
  countDeferredMarkers,
  markShipFinal,
  type ShipMarker,
  shipPass,
  writeShipMarker,
} from './shipper';

// shipPass is the sweep body shared by the resident shipper and the drainer. These
// pin the two behaviours that must DIFFER between them (the resident one is what it
// was before this branch), and the marker bookkeeping the drain cadence relies on.

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
  home = mkdtempSync(join(tmpdir(), 'aiot-shippass-'));
  setEnv('AIOT_HOME', home);
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

/** Markers are swept in directory order, so ids that sort the way the test needs. */
function mark(id: string, turns = 2, padKb = 0): string {
  const transcript = join(home, 'projects', `${id}.jsonl`);
  writeTranscript(transcript, id, home, turns, padKb);
  writeShipMarker(id, transcript, false);
  return transcript;
}

const markerPath = (id: string) => join(home, 'ship-queue', `${id}.json`);
const readMarker = (id: string): ShipMarker => JSON.parse(readFileSync(markerPath(id), 'utf8'));

function serve(statusFor: (id: string, requestNumber: number) => number): string[] {
  const seen: string[] = [];
  server = Bun.serve({
    fetch(req) {
      const id = new URL(req.url).pathname.split('/').pop() ?? '';
      seen.push(id);
      const status = statusFor(id, seen.length);
      return new Response('{}', { status });
    },
    port: 0,
  });
  setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);
  return seen;
}

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('a failing marker', () => {
  // Markers are swept in directory order, which is the filesystem's, not sorted:
  // "the first marker" is whichever the server sees first.
  const failFirst = (_id: string, requestNumber: number) => (requestNumber === 1 ? 500 : 200);

  it('does not hold back the rest of a RESIDENT sweep (as before this branch)', async () => {
    const seen = serve(failFirst);
    mark(A);
    mark(B);

    const result = await shipPass({ mode: 'resident' });

    expect(result.stop).toBe('done');
    expect(seen).toHaveLength(2);
    // The second shipped and is gone; the first stays for the next sweep.
    const [first, second] = seen as [string, string];
    expect(() => readMarker(second)).toThrow();
    expect(readMarker(first).attempts).toBe(1);
  });

  it('ends a DRAIN pass at the first transport failure', async () => {
    const seen = serve(failFirst);
    mark(A);
    mark(B);

    const result = await shipPass({ mode: 'drain' });

    expect(result.stop).toBe('transport');
    expect(seen).toHaveLength(1);
    const untouched = seen[0] === A ? B : A;
    expect(readMarker(untouched).session_id).toBe(untouched);
  });

  it('both stop at a 401: the token is the same for every marker', async () => {
    const seen = serve(() => 401);
    mark(A);
    mark(B);
    expect((await shipPass({ mode: 'resident' })).stop).toBe('unauthorized');
    expect(seen).toHaveLength(1);
  });
});

describe('the persisted retry time', () => {
  it('holds a marker back for a drainer but not for the resident shipper, as before', async () => {
    const seen = serve(() => 200);
    mark(A);
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    writeFileSync(markerPath(A), JSON.stringify({ ...readMarker(A), next_attempt_at: later }));

    expect((await shipPass({ mode: 'drain' })).stop).toBe('done');
    expect(seen).toEqual([]);

    expect((await shipPass({ mode: 'resident' })).stop).toBe('done');
    expect(seen).toEqual([A]);
  });
});

describe('a Stop landing while a failed upload is being recorded', () => {
  it('is not overwritten by the failure record (recordRetryableFailure skips a rewritten marker)', async () => {
    const id = newSessionId();
    mark(id);
    // An unmistakably older stamp, so the hook's rewrite below is distinguishable.
    writeFileSync(
      markerPath(id),
      JSON.stringify({ ...readMarker(id), updated_at: '2026-01-01T00:00:00.000Z' }),
    );
    server = Bun.serve({
      fetch() {
        // The agent's next Stop lands while the server is busy failing this upload.
        writeShipMarker(id, join(home, 'projects', `${id}.jsonl`), false);
        return new Response('boom', { status: 500 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    await shipPass({ mode: 'resident' });

    // The 500 would have recorded attempt 1 from a stale copy and put the OLD stamp
    // back, hiding the newer Stop from the next sweep.
    const marker = readMarker(id);
    expect(marker.updated_at).not.toBe('2026-01-01T00:00:00.000Z');
    expect(marker.attempts).toBeUndefined();
  });
});

describe('SessionEnd landing mid-upload', () => {
  it('markShipFinal stamps updated_at, like any hook write', () => {
    mark(A);
    // An unmistakably earlier stamp, so the assertion cannot be fooled by two writes
    // landing in the same millisecond.
    const earlier = '2026-01-01T00:00:00.000Z';
    writeFileSync(markerPath(A), JSON.stringify({ ...readMarker(A), updated_at: earlier }));
    markShipFinal(A);
    const after = readMarker(A);
    expect(after.final).toBe(true);
    expect(after.updated_at).not.toBe(earlier);
    expect(Date.parse(after.updated_at ?? '')).toBeGreaterThan(Date.parse(earlier));
  });

  it('is not lost: the in-flight upload does not retain a clean marker that has dropped `final`', async () => {
    const id = newSessionId();
    mark(id, 2, 1200); // two chunks
    let chunks = 0;
    server = Bun.serve({
      fetch() {
        chunks += 1;
        if (chunks === 1) {
          // The agent exits while chunk 1 is in flight; the hook flags the marker.
          markShipFinal(id);
          return new Response('{}', { status: 202 });
        }
        return new Response('{}', { status: 200 });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    await shipPass({ mode: 'drain' });

    // The upload finished, but the marker is the SessionEnd's, not a clean retained one:
    // the next pass ships the final transcript.
    const marker = readMarker(id);
    expect(marker.final).toBe(true);
    expect(marker.dirty).not.toBe(false);
  });
});

/** Rewrite a marker's fields in place, as a previous process or an earlier pass would have left them. */
function patchMarker(id: string, patch: Partial<ShipMarker>): void {
  writeFileSync(markerPath(id), JSON.stringify({ ...readMarker(id), ...patch }));
}

describe('a network error while the session ends', () => {
  // The SessionEnd's hook rewrites the marker (final, fresh updated_at) while an
  // upload is in flight, and the upload then fails with a network error. The failure
  // belongs to the OLD turn: the marker must keep `final`, and the deferral — which
  // writeShipMarker would carry forward onto the NEW turn — must not be written.
  it('keeps `final` and holds nothing back', async () => {
    const id = newSessionId();
    mark(id);
    patchMarker(id, { updated_at: '2026-01-01T00:00:00.000Z' });
    server = Bun.serve({
      fetch() {
        markShipFinal(id);
        // Drop the connection under the request: a network error, not a response.
        setTimeout(() => server?.stop(true), 0);
        return new Promise<Response>(() => {});
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    const result = await shipPass({ mode: 'drain' });

    expect(result.stop).toBe('transport');
    const marker = readMarker(id);
    expect(marker.final).toBe(true);
    expect(marker.updated_at).not.toBe('2026-01-01T00:00:00.000Z');
    expect(marker.next_attempt_at).toBeUndefined();
    expect(marker.attempts).toBeUndefined();
  });

  it('but a network error with NO newer hook write still defers the marker', async () => {
    const id = newSessionId();
    mark(id);
    server = Bun.serve({
      fetch() {
        setTimeout(() => server?.stop(true), 0);
        return new Promise<Response>(() => {});
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    await shipPass({ mode: 'drain' });

    expect(readMarker(id).next_attempt_at).toBeDefined();
  });
});

describe('markShipFinal', () => {
  it('drops resume state like any hook write: a superseded final upload must not resume at a stale offset', () => {
    mark(A);
    patchMarker(A, { body_hash: 'abc', body_size: 2_500_000, bytes_uploaded: 1_048_576 });
    markShipFinal(A);
    const marker = readMarker(A);
    expect(marker.final).toBe(true);
    expect(marker.bytes_uploaded).toBe(0);
    expect(marker.body_hash).toBeUndefined();
    expect(marker.body_size).toBeUndefined();
  });
});

describe('marker retry times and the "server answered" rule', () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it('clearMarkerDeferrals makes held-back dirty markers due again, and touches nothing else', () => {
    mark(A);
    mark(B);
    patchMarker(A, { next_attempt_at: future() });
    // B is a clean, already-shipped marker: bookkeeping only.
    patchMarker(B, { dirty: false, next_attempt_at: future() });
    const updatedAt = readMarker(A).updated_at;

    clearMarkerDeferrals();

    expect(readMarker(A).next_attempt_at).toBeUndefined();
    expect(readMarker(A).updated_at).toBe(updatedAt);
    expect(readMarker(B).next_attempt_at).toBeDefined();
  });

  it('countDeferredMarkers counts markers held back by a retry time, not ones waiting on the cadence', () => {
    mark(A);
    mark(B);
    const C = '00000000-0000-4000-8000-00000000000c';
    mark(C);
    patchMarker(A, { next_attempt_at: future() }); // held back after a failure
    patchMarker(B, { last_shipped_at: new Date(Date.now() - 60_000).toISOString() }); // cadence
    patchMarker(C, { dirty: false, next_attempt_at: future() }); // clean: not owed
    expect(countDeferredMarkers()).toBe(1);
  });
});
