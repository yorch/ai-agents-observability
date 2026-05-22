import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './lib/log';
import { identityPath, telemetryHome } from './lib/paths';
import { redactedLines } from './lib/transcript-stream';

const INGEST_BASE_URL = process.env.INGEST_BASE_URL ?? 'http://localhost:4000';
const SWEEP_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes

// Bandwidth throttle: max 5 MB/s
const MAX_BYTES_PER_SEC = 5 * 1024 * 1024;

// ── Ship marker ───────────────────────────────────────────────────────────────

export type ShipMarker = {
  session_id: string;
  transcript_path: string;
  partial: boolean;
  bytes_uploaded: number;
};

function shipQueueDir(): string {
  return `${telemetryHome()}/ship-queue`;
}

export function writeShipMarker(sessionId: string, transcriptPath: string, partial: boolean): void {
  try {
    const dir = shipQueueDir();
    mkdirSync(dir, { recursive: true });
    const marker: ShipMarker = {
      bytes_uploaded: 0,
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
  try {
    rmSync(join(shipQueueDir(), `${sessionId}.json`), { force: true });
  } catch {
    // ignore
  }
}

// ── JWT token ─────────────────────────────────────────────────────────────────

function loadJwt(): string | null {
  try {
    const raw = readFileSync(identityPath(), 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Bandwidth-throttled upload ────────────────────────────────────────────────

/**
 * Collect all redacted lines into a gzip-compressed buffer.
 * Using gzip, not zstd, pending Bun native zstd support.
 */
async function buildGzipBody(filePath: string): Promise<{ body: Uint8Array; hash: string }> {
  const lines: string[] = [];
  for await (const line of redactedLines(filePath)) {
    lines.push(line);
  }
  const text = lines.join('\n');
  const encoded = new TextEncoder().encode(text);

  // Compute SHA-256 before compression
  const hash = createHash('sha256').update(encoded).digest('hex');

  // Gzip compress
  const body = Bun.gzipSync(encoded);

  return { body, hash };
}

async function throttledUpload(
  url: string,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<Response> {
  // Throttle to MAX_BYTES_PER_SEC by splitting the body into chunks and
  // adding sleeps between them. For simplicity and since fetch takes the full
  // body, we compute the expected time and sleep before sending if needed.
  const expectedMs = (body.byteLength / MAX_BYTES_PER_SEC) * 1_000;
  if (expectedMs > 100) {
    await Bun.sleep(Math.floor(expectedMs));
  }
  return fetch(url, { body, headers, method: 'PUT' });
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
    ({ body, hash } = await buildGzipBody(transcript_path));
  } catch (err) {
    log('warn', 'shipper.read_error', { message: (err as Error).message, session_id });
    // skip for now, retry next sweep
    return;
  }

  const url = `${INGEST_BASE_URL}/v1/transcripts/${session_id}`;
  try {
    const res = await throttledUpload(url, body, {
      Authorization: `Bearer ${jwt}`,
      'Content-Encoding': 'gzip',
      'Content-Type': 'application/jsonlines',
      'X-Content-Hash': hash,
    });

    if (res.status >= 200 && res.status < 300) {
      deleteMarker(session_id);
      log('info', 'shipper.uploaded', { bytes: body.byteLength, session_id, status: res.status });
    } else if (res.status === 409) {
      // Conflict — skip for now, retry next sweep
      log('info', 'shipper.conflict', { session_id, status: res.status });
    } else if (res.status >= 400 && res.status < 500) {
      // 4xx (non-409): bad data, server won't accept — delete marker
      deleteMarker(session_id);
      log('warn', 'shipper.rejected', { session_id, status: res.status });
    } else {
      // 5xx / unexpected: skip for now, retry next sweep
      log('warn', 'shipper.server_error', { session_id, status: res.status });
    }
  } catch (err) {
    // Network error: skip for now, retry next sweep
    log('warn', 'shipper.network_error', { message: (err as Error).message, session_id });
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

    const jwt = loadJwt();
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
