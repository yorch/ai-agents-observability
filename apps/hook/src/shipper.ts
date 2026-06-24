import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { loadHookToken } from './lib/identity';
import { INGEST_BASE_URL } from './lib/ingest';
import { log } from './lib/log';
import { shipQueueDir } from './lib/paths';
import { redactedLines } from './lib/transcript-stream';

const SWEEP_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes

// Bandwidth throttle: max 5 MB/s
const MAX_BYTES_PER_SEC = 5 * 1024 * 1024;

// Max ship attempts before a marker is abandoned. A perpetually-failing
// transcript (server 500s, unreadable file) must not be re-read/re-uploaded
// forever every sweep.
const MAX_SHIP_ATTEMPTS = 10;

// Max age for transient outcomes (404/409/429) that DON'T bump the attempt
// counter. These are normally short-lived ordering/backpressure, but a 404 can
// also be permanent (bad session id, the session was deleted, or ingest cleaned
// it up), in which case the marker would otherwise retry forever. After this age
// we give up. Generous so a slow/offline flusher backfilling the session row
// still wins.
const MAX_TRANSIENT_AGE_MS = 24 * 60 * 60 * 1_000; // 24h

// ── Ship marker ───────────────────────────────────────────────────────────────

export type ShipMarker = {
  session_id: string;
  transcript_path: string;
  partial: boolean;
  bytes_uploaded: number;
  attempts?: number;
  /** ISO timestamp the marker was first created; used to age out stale 404s. */
  first_seen_at?: string;
};

export function writeShipMarker(sessionId: string, transcriptPath: string, partial: boolean): void {
  try {
    const dir = shipQueueDir();
    mkdirSync(dir, { recursive: true });
    const marker: ShipMarker = {
      bytes_uploaded: 0,
      first_seen_at: new Date().toISOString(),
      partial,
      session_id: sessionId,
      transcript_path: transcriptPath,
    };
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(marker, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    log('warn', 'shipper.write_marker_failed', {
      message: (err as Error).message,
      sessionId,
    });
  }
}

function readMarkers(): ShipMarker[] {
  const dir = shipQueueDir();
  if (!existsSync(dir)) {
    return [];
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const markers: ShipMarker[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      markers.push(JSON.parse(raw) as ShipMarker);
    } catch {
      // skip unreadable marker
    }
  }
  return markers;
}

function deleteMarker(sessionId: string): void {
  // { force: true } suppresses ENOENT; other errors (EACCES etc.) still throw.
  rmSync(join(shipQueueDir(), `${sessionId}.json`), { force: true });
}

/**
 * Record a failed attempt for a retryable outcome. Bumps the marker's attempt
 * counter; once the cap is hit the marker is dropped (and logged) so a poison
 * transcript can't loop forever. Returns true if the marker was abandoned.
 */
function recordRetryableFailure(marker: ShipMarker, reason: string): boolean {
  const attempts = (marker.attempts ?? 0) + 1;
  if (attempts >= MAX_SHIP_ATTEMPTS) {
    deleteMarker(marker.session_id);
    log('error', 'shipper.abandoned', { attempts, reason, session_id: marker.session_id });
    return true;
  }
  try {
    // Atomic rewrite: write a temp file then rename, so a crash mid-write can't
    // leave a truncated marker (which the reader would skip — losing the
    // transcript silently — or whose attempts counter would reset).
    const finalPath = join(shipQueueDir(), `${marker.session_id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ ...marker, attempts }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmpPath, finalPath);
  } catch {
    // best-effort; if we can't persist the attempt count we'll just retry again
  }
  return false;
}

/**
 * Handle a transient outcome (404/409/429) that should keep retrying without
 * burning the attempt budget — but abandon the marker once it's older than
 * MAX_TRANSIENT_AGE_MS, so a permanently-absent session (deleted, bad id, or
 * ingest cleanup) can't loop forever. Returns true if the marker was abandoned.
 */
function keepOrAbandonStale(marker: ShipMarker, reason: string): boolean {
  const firstSeen = marker.first_seen_at ? Date.parse(marker.first_seen_at) : Number.NaN;
  if (!Number.isNaN(firstSeen) && Date.now() - firstSeen > MAX_TRANSIENT_AGE_MS) {
    deleteMarker(marker.session_id);
    log('error', 'shipper.abandoned_stale', {
      ageMs: Date.now() - firstSeen,
      reason,
      session_id: marker.session_id,
    });
    return true;
  }
  return false;
}

// ── Bandwidth-throttled upload ────────────────────────────────────────────────

/**
 * Collect all redacted lines into a zstd-compressed buffer.
 * Matches the on-disk storage format (`.jsonl.zst`); the ingest service still
 * accepts gzip for backward compatibility, but zstd is the wire default.
 */
async function buildZstdBody(filePath: string): Promise<{ body: Uint8Array; hash: string }> {
  const lines: string[] = [];
  for await (const line of redactedLines(filePath)) {
    lines.push(line);
  }
  const text = lines.join('\n');
  const encoded = new TextEncoder().encode(text);

  // Compute SHA-256 over the uncompressed bytes (idempotency key) before compressing.
  const hash = createHash('sha256').update(encoded).digest('hex');

  const body = new Uint8Array(zstdCompressSync(encoded));

  return { body, hash };
}

async function throttledUpload(
  url: string,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<Response> {
  // Pace the upload by streaming 256 KB chunks with sleeps between them so
  // the actual transfer rate stays near MAX_BYTES_PER_SEC. A pre-send sleep
  // on the whole body does not limit bandwidth — it only delays the start.
  const CHUNK_SIZE = 256 * 1024;
  const msPerChunk = Math.ceil((CHUNK_SIZE / MAX_BYTES_PER_SEC) * 1_000);

  let offset = 0;
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= body.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK_SIZE, body.byteLength);
      controller.enqueue(body.slice(offset, end));
      offset = end;
      if (offset < body.byteLength) {
        await Bun.sleep(msPerChunk);
      }
    },
  });

  return fetch(url, {
    body: readable,
    headers: { ...headers, 'Content-Length': String(body.byteLength) },
    method: 'POST',
  });
}

// ── Shipper loop ──────────────────────────────────────────────────────────────

async function processMarker(marker: ShipMarker, jwt: string): Promise<void> {
  const { session_id, transcript_path } = marker;

  // If transcript file is missing: delete marker and move on
  if (!existsSync(transcript_path)) {
    log('warn', 'shipper.transcript_missing', { session_id, transcript_path });
    deleteMarker(session_id);
    return;
  }

  let body: Uint8Array;
  let hash: string;
  try {
    ({ body, hash } = await buildZstdBody(transcript_path));
  } catch (err) {
    log('warn', 'shipper.read_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(marker, 'read_error');
    return;
  }

  const url = `${INGEST_BASE_URL}/v1/transcripts/${session_id}`;
  try {
    const res = await throttledUpload(url, body, {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/x-zstd',
      'X-Content-Hash': hash,
    });

    if (res.status >= 200 && res.status < 300) {
      try {
        deleteMarker(session_id);
      } catch (delErr) {
        log('error', 'shipper.delete_marker_failed', {
          message: (delErr as Error).message,
          note: 'Transcript uploaded but marker persists — will re-upload next sweep',
          session_id,
        });
      }
      log('info', 'shipper.uploaded', { bytes: body.byteLength, session_id, status: res.status });
    } else if (res.status === 404) {
      // The session row doesn't exist yet — the events pipeline hasn't created
      // it (e.g. the flusher is behind or offline). Transient ordering, NOT bad
      // data: keep the marker and retry WITHOUT consuming the attempt budget, so
      // a slow/offline flusher can't cause valid transcripts to be dropped. But a
      // 404 can also be permanent (deleted/unknown session), so age the marker
      // out after MAX_TRANSIENT_AGE_MS instead of looping forever.
      if (!keepOrAbandonStale(marker, 'session_not_ready')) {
        log('info', 'shipper.session_not_ready', { session_id, status: res.status });
      }
    } else if (res.status === 409) {
      // Conflict (e.g. missing prior chunk) — transient ordering; keep + retry,
      // no attempt bump (aged out after MAX_TRANSIENT_AGE_MS).
      if (!keepOrAbandonStale(marker, 'conflict')) {
        log('info', 'shipper.conflict', { session_id, status: res.status });
      }
    } else if (res.status === 429) {
      // Rate-limited — explicit server backpressure, NOT a failure. Keep the
      // marker and retry next sweep without counting toward the attempt cap
      // (aged out after MAX_TRANSIENT_AGE_MS).
      if (!keepOrAbandonStale(marker, 'rate_limited')) {
        log('warn', 'shipper.rate_limited', { session_id, status: res.status });
      }
    } else if (res.status >= 400 && res.status < 500) {
      // 4xx (non-404, non-409, non-429): bad data, server won't accept — drop.
      try {
        deleteMarker(session_id);
      } catch {
        // best-effort; marker will be retried and rejected again next sweep
      }
      log('warn', 'shipper.rejected', { session_id, status: res.status });
    } else {
      // 5xx / unexpected: retryable, retry next sweep (capped)
      log('warn', 'shipper.server_error', { session_id, status: res.status });
      recordRetryableFailure(marker, `server_error_${res.status}`);
    }
  } catch (err) {
    // Network error: retryable, retry next sweep (capped)
    log('warn', 'shipper.network_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(marker, 'network_error');
  }
}

export async function runShipper(): Promise<void> {
  log('info', 'shipper.start', { ingestBaseUrl: INGEST_BASE_URL });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const markers = readMarkers();

    if (markers.length === 0) {
      await Bun.sleep(SWEEP_INTERVAL_MS);
      continue;
    }

    const jwt = loadHookToken();
    if (!jwt) {
      log('warn', 'shipper.no_token', { hint: 'Run `claude-telemetry login` to authenticate' });
      await Bun.sleep(SWEEP_INTERVAL_MS);
      continue;
    }

    for (const marker of markers) {
      await processMarker(marker, jwt);
    }

    await Bun.sleep(SWEEP_INTERVAL_MS);
  }
}
