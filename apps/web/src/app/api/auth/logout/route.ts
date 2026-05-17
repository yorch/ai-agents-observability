import { revokeToken, verifyAccessToken } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { clearAuthCookies, COOKIE_ACCESS } from '../../../../lib/session-cookie.js';

const db = createClient(process.env.DATABASE_URL!);

export async function POST() {
  const jar = await cookies();
  const access = jar.get(COOKIE_ACCESS)?.value;

  if (access) {
    try {
      // Revoke all tokens for this user via the access JWT's sub claim
      const { userId } = await verifyAccessToken(access);
      const tokens = await db.authToken.findMany({ where: { userId, revokedAt: null } });
      await Promise.all(tokens.map((t) => revokeToken(db, t.id)));
    } catch {
      // Best-effort revocation — still clear cookies
    }
  }

  await clearAuthCookies();
  return new NextResponse(null, { status: 204 });
}
