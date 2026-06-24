import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { AuditAction, normalizeJustification, writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { resolveOrgSessionAccess } from '@/lib/roles';
import { getS3Client, streamTranscript } from '@/lib/s3';
import { getSessionOrgContext } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Either org_admin standing access OR a non-admin (investigator) with an active,
  // scope-covering grant (§8.4). viewer_aggregate / no-grant callers get 403.
  const access = await resolveOrgSessionAccess(user, {
    ownerUserId: ctx.ownerUserId,
    sessionId: id,
  });
  if (!access) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  // Admin path: content requires the owner's opt-in OR a §8.4 justification. Grant
  // path: the approved, time-boxed grant is itself the authorization, so no extra
  // per-view justification is needed. This route is the single audit point for
  // transcript content, so a direct hit cannot bypass the log.
  const justification = normalizeJustification(req.nextUrl.searchParams.get('justification'));
  if (access === 'admin' && !ctx.shareTranscriptsWithOrg && !justification) {
    return new NextResponse('Not found', { status: 404 });
  }

  if (!ctx.transcriptS3Key) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Audit the privileged read before streaming any content back (§8.3). When an
  // admin reads a not-shared transcript, the justification is recorded loudly on
  // the row (§8.4); grant-based reads are tied to the approved grant instead.
  void writeAuditLog({
    action: AuditAction.VIEW_TRANSCRIPT,
    actorUserId: user.id,
    justification: access === 'admin' && !ctx.shareTranscriptsWithOrg ? justification : null,
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
