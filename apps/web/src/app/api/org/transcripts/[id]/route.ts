import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { AuditAction, writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';
import { canViewIndividuals } from '@/lib/roles';
import { fetchAndDecompressTranscript, getS3Client } from '@/lib/s3';
import { getSessionOrgContext } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  // Only org_admin may read another user's individual data (viewer_aggregate cannot).
  if (!canViewIndividuals(user.orgRole)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const ctx = await getSessionOrgContext(id);
  // Transcript content requires the owner to have opted into org sharing.
  if (!ctx?.shareTranscriptsWithOrg) {
    return new NextResponse('Not found', { status: 404 });
  }

  const session = await getPrisma().session.findFirst({
    select: { transcriptS3Key: true },
    where: { sessionId: id, userId: ctx.ownerUserId },
  });
  if (!session?.transcriptS3Key) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Audit the privileged read before streaming any content back (§8.3).
  void writeAuditLog({
    action: AuditAction.view_transcript,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: ctx.ownerUserId,
  });

  try {
    const decompressed = await fetchAndDecompressTranscript(getS3Client(), session.transcriptS3Key);
    return new NextResponse(decompressed, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'S3 error';
    return new NextResponse(message, { status: 500 });
  }
}
