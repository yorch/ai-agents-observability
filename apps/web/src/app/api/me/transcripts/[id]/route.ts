import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';
import { getS3Client, streamTranscript } from '@/lib/s3';

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

  try {
    const stream = await streamTranscript(getS3Client(), session.transcriptS3Key);
    return new NextResponse(stream, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'S3 error';
    return new NextResponse(message, { status: 500 });
  }
}
