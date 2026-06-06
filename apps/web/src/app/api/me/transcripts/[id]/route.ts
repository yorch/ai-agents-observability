import { Readable } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { id } = await params;

  const session = await getPrisma().session.findFirst({
    select: { transcriptS3Key: true },
    where: { sessionId: id, userId: user.id },
  });
  if (!session?.transcriptS3Key) {
    return new NextResponse('Not found', { status: 404 });
  }

  const endpoint = process.env.S3_ENDPOINT;
  const s3 = new S3Client({
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: true,
    region: process.env.S3_REGION ?? 'us-east-1',
  });

  try {
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET ?? 'transcripts',
        Key: session.transcriptS3Key,
      }),
    );

    if (!obj.Body) {
      return new NextResponse('Empty body from S3', { status: 500 });
    }

    // Buffer the entire S3 body and decompress synchronously so that a
    // corrupt/truncated object throws before the 200 headers are committed.
    // A streaming pipeline would produce a truncated 200 with no way to signal
    // the error to the client after headers are sent.
    const nodeReadable = Readable.fromWeb(obj.Body as import('stream/web').ReadableStream);
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReadable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const decompressed = zstdDecompressSync(Buffer.concat(chunks));

    return new NextResponse(decompressed, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'S3 error';
    return new NextResponse(message, { status: 500 });
  }
}
