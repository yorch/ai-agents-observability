import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withRouteLogging } from '@/lib/api-logging';
import { currentUser } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getAllRunsPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { getS3Client, streamTranscript } from '@/lib/s3';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging(
  'me.transcripts',
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await currentUser();
    if (!user) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const { id } = await params;

    // run-kind-exempt: one session by id, for its owner. A developer opening
    // their own CI session's transcript must get it, not a 404.
    const session = await getAllRunsPrisma(
      'own transcript, scoped to one session id',
    ).session.findFirst({
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
      logger.error({ err, reqId: getRequestId(), sessionId: id }, 'me.transcripts.stream_failed');
      const message = err instanceof Error ? err.message : 'S3 error';
      return new NextResponse(message, { status: 500 });
    }
  },
);
