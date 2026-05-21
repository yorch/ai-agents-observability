import { rotateRefreshToken } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { NextResponse } from 'next/server';

import { requireEnv } from '../../../../lib/env';
import { getRefreshCookie, setAuthCookies } from '../../../../lib/session-cookie';

const db = createClient(requireEnv('DATABASE_URL'));

export async function POST() {
  const refresh = await getRefreshCookie();
  if (!refresh) {
    return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
  }

  try {
    const { access, refresh: newRefresh } = await rotateRefreshToken(db, refresh);
    await setAuthCookies(access, newRefresh);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: 'Token rotation failed' }, { status: 401 });
  }
}
