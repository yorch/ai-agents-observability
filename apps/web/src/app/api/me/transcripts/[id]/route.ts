import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { currentUser } from '../../../../../lib/auth';
import { getPrisma } from '../../../../../lib/prisma';

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

    // obj.Body is a web ReadableStream in Node.js environments
    return new NextResponse(obj.Body as ReadableStream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'S3 error';
    return new NextResponse(message, { status: 500 });
  }
}
