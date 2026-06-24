import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { getConfig } from '@/lib/config';

export function getS3Client(): S3Client {
  const { s3AccessKeyId, s3Endpoint, s3Region, s3SecretAccessKey } = getConfig();
  return new S3Client({
    credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
    ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
    forcePathStyle: true,
    region: s3Region,
  });
}

/**
 * Opens the transcript object and returns a web ReadableStream of the
 * *decompressed* NDJSON, decompressing on the fly rather than buffering the
 * whole object in memory. The `GetObjectCommand` is awaited first, so a missing
 * object / bad credentials still rejects before any response headers are sent;
 * a corruption discovered mid-stream surfaces as a stream error (the browser
 * viewer tolerates a truncated tail — partial lines render as `raw`).
 */
export async function streamTranscript(
  s3: S3Client,
  key: string,
): Promise<ReadableStream<Uint8Array>> {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: getConfig().s3Bucket,
      Key: key,
    }),
  );

  if (!obj.Body) {
    throw new Error('Empty body from S3');
  }

  const source = Readable.fromWeb(obj.Body as import('stream/web').ReadableStream);
  const decompressor = createZstdDecompress();
  // `.pipe` does not forward source errors to the destination — wire them up so
  // an S3 read failure tears down the decompressor (and thus the HTTP response)
  // instead of hanging.
  source.on('error', (err) => decompressor.destroy(err));
  source.pipe(decompressor);

  return Readable.toWeb(decompressor) as ReadableStream<Uint8Array>;
}
