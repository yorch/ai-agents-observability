import { rotateRefreshToken } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { getPrisma } from '../../../../lib/prisma';
import { getRefreshCookie, setAuthCookies } from '../../../../lib/session-cookie';

export async function POST() {
  const refresh = await getRefreshCookie();
  if (!refresh) {
    return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
  }

  try {
    const { access, refresh: newRefresh } = await rotateRefreshToken(getPrisma(), refresh);
    await setAuthCookies(access, newRefresh);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: 'Token rotation failed' }, { status: 401 });
  }
}
