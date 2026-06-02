import { verifyAccessToken } from '@ai-agents-observability/auth';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { getPrisma } from '../../../../lib/prisma';
import { COOKIE_ACCESS, clearAuthCookies } from '../../../../lib/session-cookie';

export async function POST() {
  const jar = await cookies();
  const access = jar.get(COOKIE_ACCESS)?.value;

  if (access) {
    try {
      const { userId } = await verifyAccessToken(access);
      // Revoke only refresh tokens — a web sign-out must NOT revoke the long-lived
      // `hook` token, which would silently kill the developer's CLI telemetry.
      await getPrisma().authToken.updateMany({
        data: { revokedAt: new Date() },
        where: { kind: 'refresh', revokedAt: null, userId },
      });
    } catch {
      // Best-effort revocation — still clear cookies
    }
  }

  await clearAuthCookies();
  return new NextResponse(null, { status: 204 });
}
