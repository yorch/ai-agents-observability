import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import { sseUnconfirmedTotal } from './metrics';

export type S3Deps = { bucket: string; client: S3Client };

/** User metadata on the stored object, or null when it does not exist. */
export async function objectMetadata(
  deps: S3Deps,
  key: string,
): Promise<Record<string, string> | null> {
  try {
    const head = await deps.client.send(new HeadObjectCommand({ Bucket: deps.bucket, Key: key }));
    return head.Metadata ?? {};
  } catch (err) {
    if (
      err instanceof S3ServiceException &&
      (err.$metadata.httpStatusCode === 404 || err.name === 'NotFound')
    ) {
      return null;
    }
    throw err;
  }
}

export type SseRequest = {
  algorithm: ServerSideEncryption;
  kmsKeyId?: string;
  /** Host (no credentials, no path) of the configured S3 endpoint, for the warning only. */
  endpointHost?: string;
};

/**
 * Builds the SSE request from ingest config, or undefined when S3_SSE_ALGORITHM
 * is unset. One builder for every writer (transcripts, judge rationales) so they
 * cannot drift apart on what "SSE configured" means.
 */
export function sseRequestFromConfig(config: {
  s3_endpoint: string;
  s3_kms_key_id?: string | undefined;
  s3_sse_algorithm?: string | undefined;
}): SseRequest | undefined {
  if (!config.s3_sse_algorithm) {
    return undefined;
  }
  return {
    algorithm: config.s3_sse_algorithm as ServerSideEncryption,
    endpointHost: new URL(config.s3_endpoint).host,
    // config.ts documents S3_KMS_KEY_ID as ignored unless the algorithm is
    // aws:kms (or aws:kms:dsse). Sending SSEKMSKeyId alongside AES256 makes AWS
    // reject the PUT, so honour that here for every writer.
    ...(config.s3_kms_key_id && config.s3_sse_algorithm.startsWith('aws:kms')
      ? { kmsKeyId: config.s3_kms_key_id }
      : {}),
  };
}

// One warning per process, not per object: a store that ignores SSE ignores it on
// every upload, and one line per transcript would bury the log. The counter in
// metrics.ts still ticks per object, so the volume stays observable.
let sseWarned = false;

/** Test seam: re-arm the once-per-process warning. */
export function resetSseWarningForTests(): void {
  sseWarned = false;
}

/**
 * S3 echoes `x-amz-server-side-encryption` on PutObject when it encrypted the
 * object. A store that does not implement SSE (the bundled Garage) accepts the
 * request headers and answers without it. Detecting that from the response keeps
 * this store-agnostic: no endpoint or hostname sniffing. Only the algorithm is
 * compared; for aws:kms the echoed SSEKMSKeyId is the full key ARN even when an
 * alias or bare key id was configured, so comparing it would false-positive.
 */
function checkSseConfirmed(
  requested: SseRequest,
  confirmed: string | undefined,
  logger: Logger | undefined,
): void {
  if (confirmed === requested.algorithm) {
    return;
  }
  sseUnconfirmedTotal.inc();
  if (sseWarned || !logger) {
    return;
  }
  sseWarned = true;
  // Two different situations, two different claims. No echo means the store
  // ignored the SSE headers: the bundled Garage then stores plaintext, while a
  // provider such as Cloudflare R2 (which ignores x-amz-server-side-encryption
  // but encrypts everything at rest) does not. A different echo means the object
  // IS encrypted, just not the way S3_SSE_ALGORITHM asked. Neither case may say
  // "unencrypted" as a fact.
  const detail =
    confirmed === undefined
      ? 'the object store did not confirm it, so it most likely ignores SSE headers. Unless the provider encrypts at rest on its own (e.g. Cloudflare R2), transcripts are stored UNENCRYPTED (the bundled Garage store does this).'
      : `the object store reports ${confirmed} instead, so transcripts are encrypted, but not as configured.`;
  logger.warn(
    {
      confirmed: confirmed ?? null,
      endpointHost: requested.endpointHost ?? null,
      requested: requested.algorithm,
    },
    `ingest.s3.sse_unconfirmed: server-side encryption ${requested.algorithm} was requested (S3_SSE_ALGORITHM) but ${detail} See SECURITY.md (Encryption at rest). Logged once per process; the sse_unconfirmed_total metric counts every affected upload.`,
  );
}

export async function putObject(
  deps: S3Deps,
  key: string,
  body: Uint8Array,
  contentType: string,
  metadata?: Record<string, string>,
  sse?: SseRequest,
  logger?: Logger,
): Promise<void> {
  const out = await deps.client.send(
    new PutObjectCommand({
      Body: body,
      Bucket: deps.bucket,
      ContentType: contentType,
      Key: key,
      ...(metadata ? { Metadata: metadata } : {}),
      ...(sse
        ? {
            ServerSideEncryption: sse.algorithm,
            ...(sse.kmsKeyId ? { SSEKMSKeyId: sse.kmsKeyId } : {}),
          }
        : {}),
    }),
  );
  if (sse) {
    checkSseConfirmed(sse, out?.ServerSideEncryption, logger);
  }
}

// The day-bucket MUST be derived from a session-stable timestamp (the session's
// started_at), not the upload's wall clock. A retry that crosses midnight UTC
// otherwise computes a different key, the idempotency short-circuit at the
// caller fails, and the previous day's object is orphaned in S3. Callers must
// pass the session's started_at so the key remains deterministic across
// chunked and retried uploads.
export function transcriptKey(userId: string, sessionId: string, sessionStartedAt: Date): string {
  const yyyy = sessionStartedAt.getUTCFullYear();
  const mm = String(sessionStartedAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(sessionStartedAt.getUTCDate()).padStart(2, '0');
  return `transcripts/${yyyy}/${mm}/${dd}/${userId}/${sessionId}.jsonl.zst`;
}
