import { NextResponse } from 'next/server';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

export const GET = withRouteLogging('auth.tokens.list', async () => {
  const user = await currentUser();
  if (!user) {
    return jsonError('Unauthorized', 401);
  }

  const db = getPrisma();
  const tokens = await db.authToken.findMany({
    orderBy: { createdAt: 'desc' },
    where: { kind: 'HOOK', userId: user.id },
  });

  return NextResponse.json({
    tokens: tokens.map((t) => ({
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      id: t.id,
      revokedAt: t.revokedAt,
    })),
  });
});
