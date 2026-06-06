import { Readable } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';
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

// Buffers the entire S3 body and decompresses synchronously so a corrupt/truncated
// object throws before 200 headers are committed.
export async function fetchAndDecompressTranscript(
  s3: S3Client,
  key: string,
): Promise<ArrayBuffer> {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: getConfig().s3Bucket,
      Key: key,
    }),
  );

  if (!obj.Body) {
    throw new Error('Empty body from S3');
  }

  const nodeReadable = Readable.fromWeb(obj.Body as import('stream/web').ReadableStream);
  const chunks: Buffer[] = [];
  for await (const chunk of nodeReadable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const buf = zstdDecompressSync(Buffer.concat(chunks));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
