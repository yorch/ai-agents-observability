import { NextResponse } from 'next/server';

import { withRouteLogging } from '@/lib/api-logging';
import { getProvider } from '@/lib/auth-provider';
import { getConfig } from '@/lib/config';
import { oauthCallbackUrl, publicAppOrigin } from '@/lib/oauth-origin';
import { hashState, sanitizeNext, setNextCookie, setStateCookie } from '@/lib/session-cookie';

function buildCallbackUrl(request: Request): string {
  const { appBaseUrl, isProduction } = getConfig();
  return oauthCallbackUrl(
    publicAppOrigin({
      appBaseUrl,
      isProduction,
      requestUrl: request.url,
    }),
  );
}

export const GET = withRouteLogging('auth.login', async (request: Request) => {
  const url = new URL(request.url);
  const next = sanitizeNext(url.searchParams.get('next'));

  const { state, url: redirectUrl } = await getProvider().startAuthorize(buildCallbackUrl(request));
  await setStateCookie(hashState(state));
  if (next) {
    await setNextCookie(next);
  }
  return NextResponse.redirect(redirectUrl);
});
