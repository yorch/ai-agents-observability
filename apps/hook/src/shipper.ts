import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createZstdCompress } from 'node:zlib';

import { backoffMs } from './lib/backoff';
import { loadHookToken, REJECTED_TOKEN_REPROBE_MS, reauthHint } from './lib/identity';
import { getIngestBaseUrl } from './lib/ingest';
import { withLease } from './lib/lease';
import { log } from './lib/log';
import { queuePath, shipQueueDir } from './lib/paths';
import { MAX_AGE_MS, openQueueReader, queueFileId } from './lib/queue-reader';
import {
  collateDirectory,
  collatedPathFor,
  discardCollated,
  purgeCollated,
} from './lib/transcript-collate';
import { redactedLines } from './lib/transcript-stream';

const SWEEP_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes
// When another delivery process holds the lease, look again after this.
const LEASE_RETRY_MS = 5_000;

// Bandwidth throttle: max 5 MB/s
const MAX_BYTES_PER_SEC = 5 * 1024 * 1024;

// Max ship attempts before a marker is abandoned. A perpetually-failing
// transcript (server 500s, unreadable file) must not be re-read/re-uploaded
// forever every sweep.
const MAX_SHIP_ATTEMPTS = 10;

// On-demand (`aiot drain`) cadence. Claude Code's Stop fires once per response
// cycle and every upload re-sends the WHOLE redacted transcript, so a drainer
// spawned from each Stop would upload a growing file dozens of times a session.
// Instead a session's transcript ships when it ends, when it has gone quiet, or
// when the last upload is old. The resident shipper keeps its own cadence.
const SHIP_INTERVAL_MS = 10 * 60 * 1_000;
const IDLE_AFTER_MS = 5 * 60 * 1_000;
// A retained (already shipped, not re-dirtied) marker is bookkeeping only.
const SHIPPED_MARKER_TTL_MS = 24 * 60 * 60 * 1_000;
// Hold-off for outcomes that are not the transcript's fault.
const TRANSIENT_DEFER_MS = 60_000;

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
  /** ISO timestamp of the last `writeShipMarker` (a Stop). Chunk-progress writes
   * do not touch it, so a changed value means the marker was rewritten, not
   * merely progressed. Absent on markers written by older versions. */
  updated_at?: string;
  /** Set by SessionEnd: nothing more will be appended, ship it now. */
  final?: boolean;
  /** ISO timestamp of the last successful upload; drives the on-demand cadence. */
  last_shipped_at?: string;
  /** False once shipped and not touched by a hook since (on-demand only). Absent means dirty. */
  dirty?: boolean;
  /** ISO timestamp before which this marker is not retried; persisted so a new process honours it. */
  next_attempt_at?: string;
};

/**
 * Record that a session's transcript is ready to ship.
 *
 * This MERGES onto an existing marker rather than replacing it, and that is the
 * whole point. Claude Code's Stop fires once per response cycle, so an active
 * session calls this repeatedly — and a fresh marker each time reset `attempts`
 * to 0 and `first_seen_at` to now. Both give-up conditions are measured from
 * exactly those fields, so in any session still doing work neither
 * MAX_SHIP_ATTEMPTS nor a first_seen_at age check could ever be reached: a transcript
 * the server permanently rejects was re-read, re-redacted, re-compressed and
 * re-uploaded every sweep for the life of the session.
 *
 * `bytes_uploaded` and `body_size` are deliberately NOT preserved: the
 * transcript has grown since the last marker, so a resume offset from the
 * previous upload no longer describes this file, and the compressed body
 * it was derived from is stale.
 */
export function writeShipMarker(
  sessionId: string,
  transcriptPath: string,
  partial: boolean,
  opts: { final?: boolean } = {},
): void {
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
      updated_at: new Date().toISOString(),
      ...(prior?.attempts !== undefined ? { attempts: prior.attempts } : {}),
      ...(prior?.last_shipped_at ? { last_shipped_at: prior.last_shipped_at } : {}),
      ...(prior?.next_attempt_at ? { next_attempt_at: prior.next_attempt_at } : {}),
      ...(opts.final || prior?.final ? { final: true } : {}),
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

/**
 * Flag a session's marker as final (SessionEnd). Adapters that only write a
 * marker on Stop (Claude Code) never see the end of a session otherwise, and the
 * on-demand shipper would hold the last upload back until the session went idle.
 */
export function markShipFinal(sessionId: string): void {
  try {
    const path = join(shipQueueDir(), `${sessionId}.json`);
    const prior = readMarkerAt(path);
    if (!prior || prior.final) {
      return;
    }
    const tmpPath = `${path}.tmp`;
    // Bump updated_at as any hook write does: an upload in flight when the session
    // ends must see the marker as rewritten (superseded), or it would retain a
    // clean marker with `final` dropped and the final transcript would never ship.
    writeFileSync(
      tmpPath,
      JSON.stringify(
        {
          ...withoutResumeState(prior),
          bytes_uploaded: 0,
          final: true,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    renameSync(tmpPath, path);
  } catch (err) {
    log('warn', 'shipper.mark_final_failed', { message: (err as Error).message, sessionId });
  }
}

/**
 * A hook write invalidates resume state (the transcript has grown, so the compressed
 * body — and the offset into it — no longer describes the file). writeShipMarker
 * drops it; so must markShipFinal, or a superseded final upload resumes at a stale
 * offset and costs a 409.
 */
function withoutResumeState(m: ShipMarker): ShipMarker {
  const { body_hash: _h, body_size: _s, ...rest } = m;
  return rest;
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

function nextAttemptIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Marker is eligible now unless a previous process scheduled a later retry. */
function isDue(marker: ShipMarker, now = Date.now()): boolean {
  const at = marker.next_attempt_at ? Date.parse(marker.next_attempt_at) : Number.NaN;
  return Number.isNaN(at) || at <= now;
}

/**
 * Hold a marker back WITHOUT consuming its attempt budget — for outcomes that are
 * the server's or the network's state, not the transcript's. Persisted, so the
 * next process (an on-demand drainer has no memory) honours it.
 */
function deferMarker(marker: ShipMarker, ms = TRANSIENT_DEFER_MS): void {
  try {
    const finalPath = join(shipQueueDir(), `${marker.session_id}.json`);
    const onDisk = readMarkerAt(finalPath);
    // A newer Stop (or the SessionEnd) rewrote the marker since this snapshot: that
    // turn did not fail, so it is not held back — writeShipMarker carries
    // next_attempt_at forward and would otherwise delay it a minute.
    if (!onDisk || onDisk.updated_at !== marker.updated_at) {
      return;
    }
    const before = statSync(finalPath);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({ ...onDisk, next_attempt_at: nextAttemptIn(ms) }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(tmpPath, finalPath);
    // Not activity: holdUnlessIdle reads this file's mtime as "last touched by a
    // hook", and a deferral every few minutes must not keep an abandoned
    // session's marker alive forever.
    utimesSync(finalPath, before.atime, before.mtime);
  } catch {
    // best-effort
  }
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
    // A Stop rewrote the marker since `marker` was read: don't put the stale copy back.
    if (readMarkerAt(finalPath)?.updated_at !== marker.updated_at) {
      return false;
    }
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify(
        { ...marker, attempts, next_attempt_at: nextAttemptIn(backoffMs(attempts)) },
        null,
        2,
      ),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
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
    // A Stop rewrote the marker since `marker` was read: writing this stale copy
    // back would restore the old updated_at and let the final check delete the
    // newer marker. Drop the progress; the next sweep starts from 0.
    if (readMarkerAt(finalPath)?.updated_at !== marker.updated_at) {
      return;
    }
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
 * Hold a marker through an outage or a transient answer (offline, a rejected
 * token, 404/409/429) that says nothing about the transcript, so no attempt is
 * burned — but give up once the marker has been idle for MAX_AGE_MS, the same
 * 7-day horizon as the flusher's event expiry, so transcripts and events are
 * lost on one schedule.
 *
 * Idle is the marker FILE's mtime, not `first_seen_at`: writeShipMarker keeps
 * `first_seen_at` across Stops, so for a long-lived session that field is the
 * session's age and would expire a marker on its first failure. The mtime moves
 * on every Stop, so it measures "nothing has touched this for 7 days".
 * (deferMarker restores it after writing, for the same reason.)
 * A kept marker also gets a persisted retry time, which an on-demand drainer
 * honours (the resident shipper sweeps on its own timer and ignores it).
 * Returns true if the marker was abandoned.
 */
function holdUnlessIdle(marker: ShipMarker, reason: string): boolean {
  let idleMs = 0;
  try {
    idleMs = Date.now() - statSync(join(shipQueueDir(), `${marker.session_id}.json`)).mtimeMs;
  } catch {
    return false;
  }
  if (idleMs <= MAX_AGE_MS) {
    return false;
  }
  deleteMarker(marker.session_id);
  log('error', 'shipper.abandoned_idle', { idleMs, reason, session_id: marker.session_id });
  return true;
}

/** holdUnlessIdle, then — when the marker is kept — hold it back for a while. */
function holdAndDefer(marker: ShipMarker, reason: string): boolean {
  if (holdUnlessIdle(marker, reason)) {
    return true;
  }
  deferMarker(marker);
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
  signal?: AbortSignal,
  /** Polled before every chunk: a lost lease or an expired deadline ends the upload. */
  shouldStop?: () => boolean,
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
    if (signal?.aborted || shouldStop?.()) {
      // Progress so far is already persisted; the next pass resumes from it.
      throw new DOMException('upload stopped', 'AbortError');
    }
    const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalSize);
    const chunk = body.slice(offset, chunkEnd);
    const contentRange = `bytes ${offset}-${chunkEnd - 1}/${totalSize}`;
    const timeoutMs = Math.max(
      60_000,
      Math.ceil((chunk.byteLength / MAX_BYTES_PER_SEC) * 1_000 * 2),
    );
    const chunkTimeout = AbortSignal.timeout(timeoutMs);

    const res = await fetch(url, {
      body: chunk,
      headers: { ...headers, 'Content-Range': contentRange },
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, chunkTimeout]) : chunkTimeout,
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

/** What the caller needs to know to decide whether to keep going. */
/** `aborted`: WE stopped it (deadline, lost lease): not the network's doing, so nothing is logged or deferred. */
type MarkerOutcome = 'ok' | 'unauthorized' | 'transport' | 'aborted';

type ProcessOptions = {
  /** Keep a shipped, non-final marker (with `last_shipped_at`) instead of deleting it. */
  retainShipped?: boolean;
  shouldStop?: () => boolean;
  signal?: AbortSignal;
};

async function processMarker(
  marker: ShipMarker,
  jwt: string,
  opts: ProcessOptions = {},
): Promise<MarkerOutcome> {
  const { session_id, transcript_path } = marker;

  // If transcript file is missing: delete marker and move on
  if (!existsSync(transcript_path)) {
    log('warn', 'shipper.transcript_missing', { session_id, transcript_path });
    deleteMarker(session_id);
    return 'ok';
  }

  // Snapshot the on-disk marker BEFORE reading the transcript: a Stop landing
  // during redaction/compression is then seen as a rewrite (its turn is not in
  // the body we upload) instead of being folded into the snapshot. It is also
  // the source of truth for resume state, since a Stop resets bytes_uploaded.
  const currentMarker = readMarkerAt(join(shipQueueDir(), `${session_id}.json`)) ?? marker;

  let sourcePath: string | null;
  try {
    sourcePath = resolveShippablePath(marker);
  } catch (err) {
    log('warn', 'shipper.collate_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(marker, 'collate_error');
    return 'ok';
  }
  if (sourcePath === null) {
    // Nothing collatable YET — the agent may still be flushing its records.
    // Retryable (and attempt-capped), not terminal: deleting the marker here
    // would abandon the transcript on a single unlucky sweep.
    recordRetryableFailure(marker, 'collate_empty');
    return 'ok';
  }

  let body: Uint8Array;
  let hash: string;
  try {
    ({ body, hash } = await buildZstdBody(sourcePath));
  } catch (err) {
    log('warn', 'shipper.read_error', { message: (err as Error).message, session_id });
    recordRetryableFailure(marker, 'read_error');
    return 'ok';
  } finally {
    // A collation is a temp artifact: drop it whether or not the upload works.
    // The next sweep re-collates from the agent's storage, which may have grown.
    discardCollated(sourcePath);
  }

  const url = `${getIngestBaseUrl()}/v1/transcripts/${session_id}`;
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
      opts.signal,
      opts.shouldStop,
    );

    if (res.status >= 200 && res.status < 300) {
      // Re-check the marker before deleting: a Stop event may have rewritten
      // it with a new transcript_path / body_size while the upload was in
      // flight. Compare `updated_at`, which only writeShipMarker changes: the
      // chunk-progress writes set body_hash/bytes_uploaded on disk but never on
      // this in-memory marker, so comparing body_hash made every multi-chunk
      // upload look superseded. If it differs, don't delete — the next sweep
      // will handle the newer transcript. (The read-to-delete gap below is
      // microseconds and not closed; a Stop landing exactly there is lost.)
      const onDisk = readMarkerAt(join(shipQueueDir(), `${session_id}.json`));
      if (onDisk && onDisk.updated_at !== currentMarker.updated_at) {
        log('info', 'shipper.marker_superseded', { session_id });
      } else {
        try {
          if (opts.retainShipped && !currentMarker.final) {
            retainShipped(currentMarker);
          } else {
            deleteMarker(session_id);
          }
        } catch (delErr) {
          log('error', 'shipper.delete_marker_failed', {
            message: (delErr as Error).message,
            note: 'Transcript uploaded but marker persists — will re-upload next sweep',
            session_id,
          });
        }
        log('info', 'shipper.uploaded', { bytes: body.byteLength, session_id, status: res.status });
        if (opts.retainShipped) {
          // The server is answering: transcripts held back while it was not are due.
          clearMarkerDeferrals();
        }
      }
    } else if (res.status === 404) {
      // The session row doesn't exist yet — the events pipeline hasn't created
      // it (e.g. the flusher is behind or offline). Transient ordering, NOT bad
      // data: keep the marker and retry WITHOUT consuming the attempt budget, so
      // a slow/offline flusher can't cause valid transcripts to be dropped. But a
      // 404 can also be permanent (deleted/unknown session), so abandon the
      // marker once it has been idle MAX_AGE_MS instead of looping forever. That
      // is the flusher's event horizon on purpose: after a long logout the
      // flusher is still catching up on a backlog, and a shorter clock here (it
      // used to be 24h of first_seen_at) deleted transcripts on their first 404.
      if (!holdAndDefer(currentMarker, 'session_not_ready')) {
        log('info', 'shipper.session_not_ready', { session_id, status: res.status });
      }
    } else if (res.status === 409) {
      // Conflict (e.g. missing prior chunk) — transient ordering; keep + retry,
      // no attempt bump (abandoned after MAX_AGE_MS idle).
      if (!holdAndDefer(currentMarker, 'conflict')) {
        log('info', 'shipper.conflict', { session_id, status: res.status });
      }
    } else if (res.status === 429) {
      // Rate-limited — explicit server backpressure, NOT a failure. Keep the
      // marker and retry next sweep without counting toward the attempt cap
      // (abandoned after MAX_AGE_MS idle).
      if (!holdAndDefer(currentMarker, 'rate_limited')) {
        log('warn', 'shipper.rate_limited', { session_id, status: res.status });
      }
      return 'transport';
    } else if (res.status === 401) {
      // Expired/revoked token — the transcript is fine. This used to fall into
      // the generic 4xx branch below and DELETE the marker, discarding every
      // pending transcript for as long as the user stayed logged out. Keep it;
      // the token is re-read each sweep, so a fresh login recovers it. Held
      // under the idle horizon (see holdUnlessIdle), never the 24h
      // first_seen_at one. The sweep stops at the first 401: the token is the
      // same for every marker, so the rest would only repeat it.
      if (!holdUnlessIdle(currentMarker, 'unauthorized')) {
        log('warn', 'shipper.unauthorized', {
          hint: reauthHint(),
          session_id,
          status: res.status,
        });
      }
      return 'unauthorized';
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
      return 'transport';
    }
  } catch (err) {
    // An abort we caused: the marker keeps its progress and is picked up by the
    // next holder at once, not 60 s from now as a network error would imply.
    if (opts.signal?.aborted || (err instanceof DOMException && err.message === 'upload stopped')) {
      return 'aborted';
    }
    // Network error: no attempt burned. Counting it abandoned a transcript after
    // MAX_SHIP_ATTEMPTS x 10-minute sweeps (~100 min offline) while the flusher's
    // events survive 7 days. Bounded by marker idle age instead; the retry time
    // is persisted so an on-demand drainer, which has no memory, backs off too.
    log('warn', 'shipper.network_error', { message: (err as Error).message, session_id });
    holdAndDefer(currentMarker, 'network_error');
    return 'transport';
  }
  return 'ok';
}

/**
 * On-demand mode keeps the marker after a successful upload so the next Stop
 * knows when this session last shipped. It is clean (`dirty: false`) until a
 * hook touches it again, and nothing re-uploads a clean marker.
 */
function retainShipped(marker: ShipMarker): void {
  const finalPath = join(shipQueueDir(), `${marker.session_id}.json`);
  const now = new Date().toISOString();
  const tmpPath = `${finalPath}.tmp`;
  const shipped: ShipMarker = {
    bytes_uploaded: 0,
    dirty: false,
    first_seen_at: now,
    last_shipped_at: now,
    partial: marker.partial,
    session_id: marker.session_id,
    transcript_path: marker.transcript_path,
    updated_at: marker.updated_at ?? now,
  };
  writeFileSync(tmpPath, JSON.stringify(shipped, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

export type ShipPassResult = {
  /** Why the pass ended. `done` means everything it was allowed to ship was attempted. */
  stop: 'done' | 'no_token' | 'unauthorized' | 'transport' | 'cap';
};

/** Markers that still owe an upload (a retained, clean marker does not). */
export function pendingMarkerCount(): number {
  return readMarkers().filter((m) => m.dirty !== false).length;
}

/** Cadence rule for on-demand mode — see SHIP_INTERVAL_MS. `force` ships everything. */
function shouldShipNow(marker: ShipMarker, force: boolean, now: number): boolean {
  if (force || marker.final) {
    return true;
  }
  const shippedAt = marker.last_shipped_at ? Date.parse(marker.last_shipped_at) : Number.NaN;
  if (Number.isNaN(shippedAt) || now - shippedAt >= SHIP_INTERVAL_MS) {
    return true;
  }
  const updatedAt = marker.updated_at ? Date.parse(marker.updated_at) : Number.NaN;
  return !Number.isNaN(updatedAt) && now - updatedAt >= IDLE_AFTER_MS;
}

/** The markers a pass may ship now. Also GCs retained markers past their TTL. */
function selectMarkers(drain: boolean, force: boolean): ShipMarker[] {
  const now = Date.now();
  return readMarkers().filter((m) => {
    if (m.dirty === false) {
      const at = m.last_shipped_at ? Date.parse(m.last_shipped_at) : Number.NaN;
      if (!Number.isNaN(at) && now - at > SHIPPED_MARKER_TTL_MS) {
        deleteMarker(m.session_id);
      }
      return false;
    }
    // The retry time is the drainer's memory across processes. The resident
    // shipper, as before this branch, sweeps every marker on its own timer.
    return !drain || (isDue(m, now) && shouldShipNow(m, force, now));
  });
}

/**
 * The server just answered: markers held back for a failed or refused attempt are
 * due again. (Drain mode only; the resident shipper never honoured the hold.)
 */
export function clearMarkerDeferrals(): void {
  for (const m of readMarkers()) {
    if (m.next_attempt_at === undefined || m.dirty === false) {
      continue;
    }
    const path = join(shipQueueDir(), `${m.session_id}.json`);
    const onDisk = readMarkerAt(path);
    if (!onDisk || onDisk.updated_at !== m.updated_at || onDisk.next_attempt_at === undefined) {
      continue;
    }
    try {
      const before = statSync(path);
      const { next_attempt_at: _n, ...rest } = onDisk;
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(rest, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, path);
      utimesSync(path, before.atime, before.mtime);
    } catch {
      // best-effort
    }
  }
}

/** Dirty markers held back by a persisted retry time (a failed or refused upload), not by cadence. */
export function countDeferredMarkers(): number {
  const now = Date.now();
  return readMarkers().filter((m) => m.dirty !== false && !isDue(m, now)).length;
}

/** True when an on-demand pass (no `force`) would ship something right now. */
export function hasShippableMarkers(): boolean {
  return selectMarkers(true, false).length > 0;
}

/**
 * One sweep over the markers that are due. `resident` ships every marker and
 * deletes it on success, and keeps going past a failed one (the daemon's
 * long-standing behaviour: one bad transcript or one 5xx must not hold back the
 * rest of the sweep). `drain` applies the on-demand cadence, keeps a shipped
 * marker so the cadence has memory, and stops at the first transport failure
 * instead of grinding through every remaining marker against a server that is
 * down. Both stop at a 401: the token is the same for every marker.
 */
export async function shipPass(opts: {
  /** Drain mode only: ship every dirty marker regardless of cadence. */
  force?: boolean;
  mode: 'resident' | 'drain';
  signal?: AbortSignal;
  /** Polled between markers and before each chunk; true ends the pass (deadline, lost lease). */
  shouldStop?: () => boolean;
}): Promise<ShipPassResult> {
  const drain = opts.mode === 'drain';
  const markers = selectMarkers(drain, opts.force ?? false);
  if (markers.length === 0) {
    return { stop: 'done' };
  }
  const jwt = loadHookToken();
  if (!jwt) {
    log('warn', 'shipper.no_token', { hint: 'Run `aiot login` to authenticate' });
    return { stop: 'no_token' };
  }
  for (const marker of markers) {
    if (opts.shouldStop?.()) {
      return { stop: 'cap' };
    }
    const outcome = await processMarker(marker, jwt, {
      retainShipped: drain,
      ...(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (outcome === 'aborted') {
      return { stop: 'cap' };
    }
    if (outcome === 'unauthorized' || (outcome === 'transport' && drain)) {
      return { stop: outcome };
    }
  }
  return { stop: 'done' };
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

  // Only here for its connection: the delivery lease lives in queue.db.
  let queueFile = queueFileId(queuePath());
  let queue = openQueueReader(queuePath());
  queueFile ??= queueFileId(queuePath());
  let rejectedToken: string | null = null;
  let rejectedAt = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let wait = SWEEP_INTERVAL_MS;
      // Follow queue.db across a `purge-local`, or the lease below would sit on the
      // deleted file and exclude nobody (see the same check in runFlusher).
      const currentFile = queueFileId(queuePath());
      if (currentFile !== queueFile) {
        if (currentFile === null) {
          await Bun.sleep(LEASE_RETRY_MS);
          continue;
        }
        queue.close();
        queue = openQueueReader(queuePath());
        queueFile = currentFile;
        log('info', 'shipper.queue_replaced', {});
      }
      const jwt = loadHookToken();
      // A token ingest rejected would only be rejected again — after reading,
      // redacting and compressing a whole transcript to find out. Skip the sweep
      // until the token changes (or the re-probe interval passes).
      const skip =
        jwt !== null &&
        jwt === rejectedToken &&
        Date.now() - rejectedAt < REJECTED_TOKEN_REPROBE_MS;
      if (!skip && readMarkers().length > 0) {
        rejectedToken = null;
        // One transcript uploader at a time across every delivery process. A holder
        // elsewhere (a drainer, an `aiot import`) is not an error — it will finish
        // on its own, and the flusher no longer shares this lease — so look again
        // in seconds rather than skipping a whole 10-minute sweep, which is what
        // delayed every transcript by 10 minutes when the lease was shared.
        const leased = await withLease(queue.db, 'shipper', (lease) =>
          shipPass({
            mode: 'resident',
            shouldStop: () => !lease.check(),
            signal: lease.signal,
          }),
        );
        if (!leased.held) {
          wait = LEASE_RETRY_MS;
        } else if (leased.value.stop === 'unauthorized') {
          rejectedToken = jwt;
          rejectedAt = Date.now();
        }
      }
      await Bun.sleep(wait);
    }
  } finally {
    queue.close();
  }
}
