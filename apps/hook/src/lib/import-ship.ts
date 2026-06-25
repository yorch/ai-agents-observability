import type { Event } from '@ai-agents-observability/schemas';

import { buildBatchEnvelope } from '../flusher';
import { buildZstdBody } from '../shipper';

// Read at call time so test env overrides applied in beforeEach take effect.
function ingestBaseUrl(): string {
  return process.env.INGEST_BASE_URL ?? 'http://localhost:4000';
}

export type BatchResult = {
  accepted: number;
  deduped: number;
  rejected: number;
};

/**
 * POST one batch of events to /v1/events.
 * Returns parsed BatchResult on 2xx.
 * Throws AuthError (a custom Error subclass) on 401 — caller should abort.
 * Throws on network error or 5xx (caller decides retry strategy).
 * On 4xx (non-401): returns { accepted:0, deduped:0, rejected: events.length }
 *   (bad data the server won't accept — log and continue).
 */
export async function postEventBatch(events: Event[], jwt: string): Promise<BatchResult> {
  const body = JSON.stringify(buildBatchEnvelope(events));
  const res = await fetch(`${ingestBaseUrl()}/v1/events`, {
    body,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (res.status === 401) {
    throw new AuthError('Unauthorized (401) — re-run `claude-telemetry login`');
  }
  if (res.status >= 500) {
    throw new Error(`Server error ${res.status}`);
  }
  if (res.status >= 400) {
    // Bad data — accept/dedup/reject all as rejected
    return { accepted: 0, deduped: 0, rejected: events.length };
  }

  // 2xx — parse response
  try {
    const data = (await res.json()) as { accepted?: number; deduped?: number; rejected?: number };
    return {
      accepted: data.accepted ?? 0,
      deduped: data.deduped ?? 0,
      rejected: data.rejected ?? 0,
    };
  } catch {
    // Unparseable 2xx body — treat as success
    return { accepted: events.length, deduped: 0, rejected: 0 };
  }
}

/** Thrown on 401 from the server — the import command should abort on this. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export type UploadResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'session_not_found' | 'skipped' | 'error'; message: string };

/**
 * Upload a session transcript via buildZstdBody() → POST /v1/transcripts/{sessionId}.
 * The raw transcript is NEVER sent — buildZstdBody() redacts + compresses first.
 *
 * Returns { ok: true } on 2xx.
 * Returns { ok: false, reason: 'session_not_found' } on 404 (events not yet created, or
 *   session empty — warn, don't retry).
 * Returns { ok: false, reason: 'error', message } on other failures.
 */
export async function uploadTranscript(
  sessionId: string,
  transcriptPath: string,
  jwt: string,
): Promise<UploadResult> {
  let body: Uint8Array;
  let hash: string;
  try {
    ({ body, hash } = await buildZstdBody(transcriptPath));
  } catch (err) {
    return {
      message: `Failed to read/compress transcript: ${(err as Error).message}`,
      ok: false,
      reason: 'error',
    };
  }

  try {
    const res = await fetch(`${ingestBaseUrl()}/v1/transcripts/${sessionId}`, {
      body,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Length': String(body.byteLength),
        'Content-Type': 'application/x-zstd',
        'X-Content-Hash': hash,
      },
      method: 'POST',
    });

    if (res.status >= 200 && res.status < 300) {
      return { bytes: body.byteLength, ok: true };
    }
    if (res.status === 404) {
      return {
        message: `Session ${sessionId} not found on server (events may all be duplicates or session was empty)`,
        ok: false,
        reason: 'session_not_found',
      };
    }
    return { message: `Server returned ${res.status}`, ok: false, reason: 'error' };
  } catch (err) {
    return { message: `Network error: ${(err as Error).message}`, ok: false, reason: 'error' };
  }
}
