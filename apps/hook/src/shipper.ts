import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createZstdCompress } from 'node:zlib';

import { loadHookToken } from './lib/identity';
import { getIngestBaseUrl } from './lib/ingest';
import { log } from './lib/log';
import { shipQueueDir } from './lib/paths';
import {
  collateDirectory,
  collatedPathFor,
  discardCollated,
  purgeCollated,
} from './lib/transcript-collate';
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
  /** Size of the compressed body when `bytes_uploaded` was last recorded. Used
   * to validate that a resume offset still describes the current body — if the
   * transcript grew between sweeps, the compressed bytes changed even if the
   * size happens to match, so this is a necessary-but-not-sufficient check. */
  body_size?: number;
  /** SHA-256 of the compressed body when `bytes_uploaded` was last recorded.
   * Stronger than body_size alone: catches same-size-different-content changes
   * that body_size would miss. If the hash doesn't match the current body, the
   * upload starts from 0. */
  body_hash?: string;
  attempts?: number;
  /** ISO timestamp the marker was first created; used to age out stale 404s. */
  first_seen_at?: string;
};

/**
 * Record that a session's transcript is ready to ship.
 *
 * This MERGES onto an existing marker rather than replacing it, and that is the
 * whole point. Claude Code's Stop fires once per response cycle, so an active
 * session calls this repeatedly — and a fresh marker each time reset `attempts`
 * to 0 and `first_seen_at` to now. Both give-up conditions are measured from
 * exactly those fields, so in any session still doing work neither
 * MAX_SHIP_ATTEMPTS nor MAX_TRANSIENT_AGE_MS could ever be reached: a transcript
 * the server permanently rejects was re-read, re-redacted, re-compressed and
 * re-uploaded every sweep for the life of the session.
 *
 * `bytes_uploaded` and `body_size` are deliberately NOT preserved: the
 * transcript has grown since the last marker, so a resume offset from the
 * previous upload no longer describes this file, and the compressed body
 * it was derived from is stale.
 */
export function writeShipMarker(sessionId: string, transcriptPath: string, partial: boolean): void {
  try {
    const dir = shipQueueDir();
    // 0o700 like every other per-session state dir — this holds session ids and
    // local transcript paths.
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const finalPath = join(dir, `${sessionId}.json`);
    const prior = readMarkerAt(finalPath);
    const marker: ShipMarker = {
      bytes_uploaded: 0,
      // Keep the ORIGINAL first-seen so the staleness clock keeps running, and
      // carry the attempt count so the retry budget keeps counting down.
      first_seen_at: prior?.first_seen_at ?? new Date().toISOString(),
      partial,
      session_id: sessionId,
      transcript_path: transcriptPath,
      ...(prior?.attempts !== undefined ? { attempts: prior.attempts } : {}),
    };
    // tmp + rename, as `recordRetryableFailure` already does below: a crash
    // mid-write must not leave a truncated marker, which the reader skips —
    // silently losing the transcript.
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(marker, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmpPath, finalPath);
  } catch (err) {
    log('warn', 'shipper.write_marker_failed', {
      message: (err as Error).message,
      sessionId,
    });
  }
}

/** One marker by path, or null when absent/unreadable. */
function readMarkerAt(path: string): ShipMarker | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ShipMarker;
  } catch {
    return null;
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
 * Atomically update the marker's `bytes_uploaded`, `body_size`, and `body_hash`
 * after a successful chunk upload. A crash after the server acks a chunk but
 * before this write completes means the chunk is re-sent on the next sweep —
 * the server overwrites the scratch file at start=0, so this is safe. A crash
 * mid-write leaves a temp file, which the reader skips.
 */
function updateMarkerProgress(
  marker: ShipMarker,
  bytesUploaded: number,
  bodySize: number,
  bodyHash: string,
): void {
  try {
    const finalPath = join(shipQueueDir(), `${marker.session_id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify(
        { ...marker, body_hash: bodyHash, body_size: bodySize, bytes_uploaded: bytesUploaded },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(tmpPath, finalPath);
  } catch {
    // best-effort — if we can't persist progress, the next sweep re-uploads
    // from the last persisted offset (or from 0 if this was the first chunk).
  }
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
 * Stream the redacted transcript through a zstd compressor, hashing the
 * uncompressed bytes as they pass. The full uncompressed transcript is never
 * held in memory — only the (much smaller) compressed output is buffered, which
 * the throttled upload needs in full to set Content-Length and pace chunks.
 * Matches the on-disk storage format (`.jsonl.zst`); the ingest service still
 * accepts gzip for backward compatibility, but zstd is the wire default.
 */
export async function buildZstdBody(filePath: string): Promise<{ body: Uint8Array; hash: string }> {
  const hash = createHash('sha256');
  const compressor = createZstdCompress();
  const chunks: Buffer[] = [];
  compressor.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    compressor.once('end', resolve);
    compressor.once('error', reject);
  });

  try {
    // Frame lines exactly as `lines.join('\n')` did: a separator before every
    // line except the first, so the hash (and decompressed bytes) are unchanged.
    let first = true;
    for await (const line of redactedLines(filePath)) {
      const piece = Buffer.from(first ? line : `\n${line}`, 'utf8');
      first = false;
      hash.update(piece);
      if (!compressor.write(piece)) {
        await new Promise<void>((resolve) => compressor.once('drain', resolve));
      }
    }
    compressor.end();
    await finished;
  } catch (err) {
    // If reading/redaction throws mid-stream, tear the compressor down so its
    // buffered output is freed promptly; swallow any late rejection from it.
    compressor.destroy();
    finished.catch(() => {});
    throw err;
  }

  return { body: new Uint8Array(Buffer.concat(chunks)), hash: hash.digest('hex') };
}

// ── Resumable chunked upload ──────────────────────────────────────────────────

const UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1 MB — well under the server's 16 MB per-chunk cap

/**
 * Upload a compressed transcript body in chunks with `Content-Range` headers,
 * resuming from the marker's last persisted offset when the body is unchanged.
 *
 * The server assembles chunks in a per-session scratch file and processes the
 * transcript only when the final chunk arrives. A 202 acknowledges an
 * intermediate chunk; 200/201 means the full body was received and processed.
 *
 * Resume safety: the marker records `body_size` AND `body_hash` (sha256 of the
 * compressed body) alongside `bytes_uploaded`. Both must match to resume — size
 * alone can collide (same size, different content), but the hash makes it
 * cryptographically impossible to resume from a stale offset on a different body.
 *
 * On 409 ("missing prior chunks"): the server's scratch file was cleaned up
 * (by sweep-scratch or a restart). Reset to 0 and retry once. A 409 on the
 * first chunk (start=0) is returned to the caller for status-specific handling.
 *
 * Bandwidth pacing: sleep between chunks to stay near MAX_BYTES_PER_SEC, the
 * same throttle `throttledUpload` enforced by streaming 256 KB pieces.
 */
export async function uploadWithResume(
  url: string,
  body: Uint8Array,
  headers: Record<string, string>,
  marker: ShipMarker,
  bodyHash: string,
): Promise<Response> {
  const totalSize = body.byteLength;
  if (totalSize === 0) {
    return new Response('{}', { status: 200 });
  }

  // Resume only if the compressed body is the same one the marker recorded.
  // Both body_size AND body_hash must match. body_size is a cheap fast-path
  // reject; body_hash is the cryptographic guarantee. If either mismatches,
  // start from 0.
  let offset = 0;
  if (
    marker.body_size === totalSize &&
    marker.body_hash === bodyHash &&
    marker.bytes_uploaded > 0
  ) {
    offset = marker.bytes_uploaded;
    log('info', 'shipper.resuming', { offset, session_id: marker.session_id, total: totalSize });
  }

  const msPerChunk = Math.ceil((UPLOAD_CHUNK_SIZE / MAX_BYTES_PER_SEC) * 1_000);
  let retried409 = false;

  while (offset < totalSize) {
    const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalSize);
    const chunk = body.slice(offset, chunkEnd);
    const contentRange = `bytes ${offset}-${chunkEnd - 1}/${totalSize}`;
    const timeoutMs = Math.max(
      60_000,
      Math.ceil((chunk.byteLength / MAX_BYTES_PER_SEC) * 1_000 * 2),
    );

    const res = await fetch(url, {
      body: chunk,
      headers: { ...headers, 'Content-Range': contentRange },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 202) {
      // Intermediate chunk acked — persist progress for crash recovery.
      offset = chunkEnd;
      updateMarkerProgress(marker, offset, totalSize, bodyHash);
      // Pace: sleep proportional to chunk size to respect the bandwidth cap.
      if (offset < totalSize) {
        await Bun.sleep(msPerChunk);
      }
      continue;
    }

    if (res.status === 409 && !retried409 && offset > 0) {
      // Server scratch file was cleaned up — reset to 0 and retry from the start.
      log('warn', 'shipper.resume_conflict', { offset, session_id: marker.session_id });
      retried409 = true;
      offset = 0;
      updateMarkerProgress(marker, 0, totalSize, bodyHash);
      continue;
    }

    // 200/201 (final chunk processed), or 4xx/5xx (error) — return for caller.
    return res;
  }

  // All chunks were 202 but the loop exited without a final 200/201 — this
  // shouldn't happen (the last chunk always gets 200/201), but return a
  // synthetic success rather than crashing.
  return new Response('{}', { status: 200 });
}

// ── Shipper loop ──────────────────────────────────────────────────────────────

/**
 * The file to ship for a marker. Usually the marker's own path — but an agent
 * whose history is a DIRECTORY (opencode) gets it collated into one JSONL here,
 * in the shipper process, deliberately out of the hook's hot path (P12-009).
 * Returns null when the directory holds nothing shippable.
 */
function resolveShippablePath(marker: ShipMarker): string | null {
  const { session_id, transcript_path } = marker;
  if (!statSync(transcript_path).isDirectory()) {
    return transcript_path;
  }
  const dest = collatedPathFor(session_id);
  const records = collateDirectory(transcript_path, dest);
  if (records === 0) {
    log('warn', 'shipper.collate_empty', { session_id, transcript_path });
    return null;
  }
  log('info', 'shipper.collated', { records, session_id });
  return dest;
}

async function processMarker(marker: ShipMarker, jwt: string): Promise<void> {
  const { session_id, transcript_path } = marker;

  // If transcript file is missing: delete marker and move on
  if (!existsSync(transcript_path)) {
    log('warn', 'shipper.transcript_missing', { session_id, transcript_path });
    deleteMarker(session_id);
    return;
  }

  let sourcePath: string | null;
  try {
    sourcePath = resolveShippablePath(marker);
  } catch (err) {
    log('warn', 'shipper.collate_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(marker, 'collate_error');
    return;
  }
  if (sourcePath === null) {
    // Nothing collatable YET — the agent may still be flushing its records.
    // Retryable (and attempt-capped), not terminal: deleting the marker here
    // would abandon the transcript on a single unlucky sweep.
    recordRetryableFailure(marker, 'collate_empty');
    return;
  }

  let body: Uint8Array;
  let hash: string;
  try {
    ({ body, hash } = await buildZstdBody(sourcePath));
  } catch (err) {
    log('warn', 'shipper.read_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(marker, 'read_error');
    return;
  } finally {
    // A collation is a temp artifact: drop it whether or not the upload works.
    // The next sweep re-collates from the agent's storage, which may have grown.
    discardCollated(sourcePath);
  }

  const url = `${getIngestBaseUrl()}/v1/transcripts/${session_id}`;
  // Re-read the marker from disk: a Stop event may have fired since the
  // sweep started, resetting bytes_uploaded and body_size/body_hash. The
  // on-disk marker is the source of truth for resume state.
  const currentMarker = readMarkerAt(join(shipQueueDir(), `${session_id}.json`)) ?? marker;
  try {
    const res = await uploadWithResume(
      url,
      body,
      {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/x-zstd',
        'X-Content-Hash': hash,
      },
      currentMarker,
      hash,
    );

    if (res.status >= 200 && res.status < 300) {
      // Re-check the marker before deleting: a Stop event may have rewritten
      // it with a new transcript_path / body_size while the upload was in
      // flight. If the on-disk marker no longer matches what we just uploaded
      // (different body_hash or body_size), don't delete it — the next sweep
      // will handle the newer transcript.
      const onDisk = readMarkerAt(join(shipQueueDir(), `${session_id}.json`));
      if (onDisk && onDisk.body_hash !== currentMarker.body_hash) {
        log('info', 'shipper.marker_superseded', { session_id });
      } else {
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
      }
    } else if (res.status === 404) {
      // The session row doesn't exist yet — the events pipeline hasn't created
      // it (e.g. the flusher is behind or offline). Transient ordering, NOT bad
      // data: keep the marker and retry WITHOUT consuming the attempt budget, so
      // a slow/offline flusher can't cause valid transcripts to be dropped. But a
      // 404 can also be permanent (deleted/unknown session), so age the marker
      // out after MAX_TRANSIENT_AGE_MS instead of looping forever.
      if (!keepOrAbandonStale(currentMarker, 'session_not_ready')) {
        log('info', 'shipper.session_not_ready', { session_id, status: res.status });
      }
    } else if (res.status === 409) {
      // Conflict (e.g. missing prior chunk) — transient ordering; keep + retry,
      // no attempt bump (aged out after MAX_TRANSIENT_AGE_MS).
      if (!keepOrAbandonStale(currentMarker, 'conflict')) {
        log('info', 'shipper.conflict', { session_id, status: res.status });
      }
    } else if (res.status === 429) {
      // Rate-limited — explicit server backpressure, NOT a failure. Keep the
      // marker and retry next sweep without counting toward the attempt cap
      // (aged out after MAX_TRANSIENT_AGE_MS).
      if (!keepOrAbandonStale(currentMarker, 'rate_limited')) {
        log('warn', 'shipper.rate_limited', { session_id, status: res.status });
      }
    } else if (res.status === 413) {
      // Too large for the server's body limit. Retrying the same bytes cannot
      // help, so the marker still goes — but this is a capacity problem, not bad
      // data, and it is logged as its own thing so a fleet hitting the limit is
      // visible rather than buried in "rejected".
      try {
        deleteMarker(session_id);
      } catch {
        // best-effort
      }
      log('error', 'shipper.too_large', { bytes: body.byteLength, session_id });
    } else if (res.status >= 400 && res.status < 500) {
      // 4xx (non-404, non-409, non-413, non-429): bad data, server won't accept — drop.
      try {
        deleteMarker(session_id);
      } catch {
        // best-effort; marker will be retried and rejected again next sweep
      }
      log('warn', 'shipper.rejected', { session_id, status: res.status });
    } else {
      // 5xx / unexpected: retryable, retry next sweep (capped)
      log('warn', 'shipper.server_error', { session_id, status: res.status });
      recordRetryableFailure(currentMarker, `server_error_${res.status}`);
    }
  } catch (err) {
    // Network error: retryable, retry next sweep (capped)
    log('warn', 'shipper.network_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(currentMarker, 'network_error');
  }
}

export async function runShipper(): Promise<void> {
  log('info', 'shipper.start', { ingestBaseUrl: getIngestBaseUrl() });

  // A staged collation is an unredacted plaintext copy of an agent's history,
  // normally deleted the moment its upload finishes. One that survived a kill
  // must not outlive the process that made it.
  try {
    purgeCollated();
  } catch {
    // best-effort
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const markers = readMarkers();

    if (markers.length === 0) {
      await Bun.sleep(SWEEP_INTERVAL_MS);
      continue;
    }

    const jwt = loadHookToken();
    if (!jwt) {
      log('warn', 'shipper.no_token', { hint: 'Run `aiot login` to authenticate' });
      await Bun.sleep(SWEEP_INTERVAL_MS);
      continue;
    }

    for (const marker of markers) {
      await processMarker(marker, jwt);
    }

    await Bun.sleep(SWEEP_INTERVAL_MS);
  }
}
