import { rotateRefreshToken } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { getRefreshCookie, setAuthCookies } from '@/lib/session-cookie';

export const POST = withRouteLogging('auth.refresh', async () => {
  const refresh = await getRefreshCookie();
  if (!refresh) {
    return jsonError('No refresh token', 401);
  }

  try {
    const { access, refresh: newRefresh } = await rotateRefreshToken(getPrisma(), refresh);
    await setAuthCookies(access, newRefresh);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    logger.warn({ err, reqId: getRequestId() }, 'auth.refresh.rotation_failed');
    return jsonError('Token rotation failed', 401);
  }
});
