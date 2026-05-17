import { verifyAccessToken } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { requireEnv } from '../../../../lib/env.js';
import { COOKIE_ACCESS, clearAuthCookies } from '../../../../lib/session-cookie.js';

const db = createClient(requireEnv('DATABASE_URL'));

export async function POST() {
  const jar = await cookies();
  const access = jar.get(COOKIE_ACCESS)?.value;

  if (access) {
    try {
      const { userId } = await verifyAccessToken(access);
      await db.authToken.updateMany({
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
