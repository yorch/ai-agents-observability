import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

export type S3Deps = { bucket: string; client: S3Client };

export async function objectExists(deps: S3Deps, key: string): Promise<boolean> {
  try {
    await deps.client.send(new HeadObjectCommand({ Bucket: deps.bucket, Key: key }));
    return true;
  } catch (err) {
    if (
      err instanceof S3ServiceException &&
      (err.$metadata.httpStatusCode === 404 || err.name === 'NotFound')
    ) {
      return false;
    }
    throw err;
  }
}

export async function putObject(
  deps: S3Deps,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await deps.client.send(
    new PutObjectCommand({
      Body: body,
      Bucket: deps.bucket,
      ContentType: contentType,
      Key: key,
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
