import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';

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

export async function putObject(
  deps: S3Deps,
  key: string,
  body: Uint8Array,
  contentType: string,
  metadata?: Record<string, string>,
  sse?: { algorithm: ServerSideEncryption; kmsKeyId?: string },
): Promise<void> {
  await deps.client.send(
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
