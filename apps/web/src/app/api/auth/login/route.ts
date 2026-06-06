import { NextResponse } from 'next/server';

import { getProvider } from '@/lib/auth-provider';
import { hashState, sanitizeNext, setNextCookie, setStateCookie } from '@/lib/session-cookie';

function buildCallbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/api/auth/callback`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = sanitizeNext(url.searchParams.get('next'));

  const { state, url: redirectUrl } = await getProvider().startAuthorize(buildCallbackUrl(request));
  await setStateCookie(hashState(state));
  if (next) {
    await setNextCookie(next);
  }
  return NextResponse.redirect(redirectUrl);
}
