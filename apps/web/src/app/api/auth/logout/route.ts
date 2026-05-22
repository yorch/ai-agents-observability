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
      await getPrisma().authToken.updateMany({
        data: { revokedAt: new Date() },
        where: { revokedAt: null, userId },
      });
    } catch {
      // Best-effort revocation — still clear cookies
    }
  }

  await clearAuthCookies();
  return new NextResponse(null, { status: 204 });
}
