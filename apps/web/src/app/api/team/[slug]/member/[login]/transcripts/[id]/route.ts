import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withRouteLogging } from '@/lib/api-logging';
import { currentUser } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { getS3Client, streamTranscript } from '@/lib/s3';
import { getMemberForTeam } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

const LEAD_ROLES = ['LEAD', 'MAINTAINER'] as const;

export const GET = withRouteLogging(
  'team.member.transcripts',
  async (
    _req: NextRequest,
    { params }: { params: Promise<{ id: string; login: string; slug: string }> },
  ) => {
    const { id, login, slug } = await params;

    const user = await currentUser();
    if (!user) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const prisma = getPrisma();

    const team = await prisma.team.findUnique({
      select: { id: true },
      where: { githubSlug: slug },
    });
    if (!team) {
      return new NextResponse('Not found', { status: 404 });
    }

    const membership = await prisma.teamMember.findUnique({
      select: { leftAt: true, roleInTeam: true },
      where: { teamId_userId: { teamId: team.id, userId: user.id } },
    });
    if (!membership || membership.leftAt || !LEAD_ROLES.includes(membership.roleInTeam as never)) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    const member = await getMemberForTeam(team.id, login);
    if (!member?.canViewTranscripts) {
      return new NextResponse('Not found', { status: 404 });
    }

    const session = await prisma.session.findFirst({
      select: { transcriptS3Key: true },
      where: { sessionId: id, userId: member.userId },
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
      logger.error(
        { err, reqId: getRequestId(), sessionId: id },
        'team.member.transcripts.stream_failed',
      );
      const message = err instanceof Error ? err.message : 'S3 error';
      return new NextResponse(message, { status: 500 });
    }
  },
);
