import { NextResponse } from 'next/server';

import { getProvider } from '../../../../lib/auth-provider';
import { hashState, setStateCookie } from '../../../../lib/session-cookie';

function buildCallbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/api/auth/callback`;
}

export async function GET(request: Request) {
  const { state, url } = await getProvider().startAuthorize(buildCallbackUrl(request));
  await setStateCookie(hashState(state));
  return NextResponse.redirect(url);
}
