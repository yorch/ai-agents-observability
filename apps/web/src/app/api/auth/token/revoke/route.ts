import { revokeToken } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';

const RevokeBody = z.object({
  tokenId: z.string().uuid(),
});

export const POST = withRouteLogging('auth.token.revoke', async (request: Request) => {
  const user = await currentUser();
  if (!user) {
    return jsonError('Unauthorized', 401);
  }

  const parsed = RevokeBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError('tokenId is required', 400);
  }

  const { tokenId } = parsed.data;
  const db = getPrisma();

  // Verify the token belongs to the current user before revoking.
  const token = await db.authToken.findFirst({
    where: { id: tokenId, kind: 'HOOK', userId: user.id },
  });

  if (!token) {
    return jsonError('Token not found', 404);
  }

  if (token.revokedAt) {
    return jsonError('Token already revoked', 409);
  }

  try {
    await revokeToken(db, tokenId);
    await writeAuditLog({
      action: 'HOOK_TOKEN_REVOKED',
      actorUserId: user.id,
      justification: 'User revoked hook token via dashboard',
      targetUserId: user.id,
    });
  } catch (err) {
    logger.error({ err, reqId: getRequestId(), tokenId }, 'auth.token.revoke_failed');
    return jsonError('Revoke failed', 500);
  }

  return NextResponse.json({ ok: true });
});
