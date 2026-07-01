import { verifyAccessToken } from '@ai-agents-observability/auth';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { withRouteLogging } from '@/lib/api-logging';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { COOKIE_ACCESS, clearAuthCookies } from '@/lib/session-cookie';

export const POST = withRouteLogging('auth.logout', async () => {
  const jar = await cookies();
  const access = jar.get(COOKIE_ACCESS)?.value;

  if (access) {
    try {
      const { userId } = await verifyAccessToken(access);
      // Revoke only refresh tokens — a web sign-out must NOT revoke the long-lived
      // `hook` token, which would silently kill the developer's CLI telemetry.
      await getPrisma().authToken.updateMany({
        data: { revokedAt: new Date() },
        where: { kind: 'REFRESH', revokedAt: null, userId },
      });
    } catch (err) {
      // Best-effort revocation — still clear cookies
      logger.warn({ err, reqId: getRequestId() }, 'auth.logout.revoke_failed');
    }
  }

  await clearAuthCookies();
  return new NextResponse(null, { status: 204 });
});
