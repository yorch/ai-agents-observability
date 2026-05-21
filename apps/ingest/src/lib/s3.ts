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

export function transcriptKey(userId: string, sessionId: string, ts: Date = new Date()): string {
  const yyyy = ts.getUTCFullYear();
  const mm = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ts.getUTCDate()).padStart(2, '0');
  return `transcripts/${yyyy}/${mm}/${dd}/${userId}/${sessionId}.jsonl.zst`;
}
