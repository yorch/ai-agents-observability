import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { AuditAction, normalizeJustification, writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { canViewIndividuals } from '@/lib/roles';
import { getS3Client, streamTranscript } from '@/lib/s3';
import { getSessionOrgContext } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  if (!ctx) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Access requires EITHER the owner opted in (shareTranscriptsWithOrg) OR the
  // admin supplied a §8.4 justification. This route is the single audit point
  // for transcript content, so a direct hit cannot bypass the log.
  const justification = normalizeJustification(req.nextUrl.searchParams.get('justification'));
  if (!ctx.shareTranscriptsWithOrg && !justification) {
    return new NextResponse('Not found', { status: 404 });
  }

  if (!ctx.transcriptS3Key) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Audit the privileged read before streaming any content back (§8.3). When the
  // owner has NOT shared, the justification is recorded loudly on the row (§8.4).
  void writeAuditLog({
    action: AuditAction.view_transcript,
    actorUserId: user.id,
    justification: ctx.shareTranscriptsWithOrg ? undefined : (justification ?? undefined),
    targetSessionId: id,
    targetUserId: ctx.ownerUserId,
  });

  try {
    const stream = await streamTranscript(getS3Client(), ctx.transcriptS3Key);
    return new NextResponse(stream, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'S3 error';
    return new NextResponse(message, { status: 500 });
  }
}
