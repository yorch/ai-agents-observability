import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { currentUser } from '../../../../lib/auth';
import { getPrisma } from '../../../../lib/prisma';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const prisma = getPrisma();

  await prisma.$transaction([
    prisma.deletionRequest.create({
      data: {
        reason: typeof body.reason === 'string' ? body.reason : 'user_requested',
        userId: user.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        action: 'delete_request',
        actorUserId: user.id,
        justification: 'User requested data deletion',
        targetUserId: user.id,
      },
    }),
  ]);

  return NextResponse.json({ queued: true });
}
