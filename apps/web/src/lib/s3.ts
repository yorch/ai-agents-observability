import { Readable } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { requireEnv } from '@/lib/env';

export function getS3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  return new S3Client({
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    },
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: true,
    region: process.env.S3_REGION ?? 'us-east-1',
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
      Bucket: requireEnv('S3_BUCKET'),
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
