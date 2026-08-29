import type { ExternalIdentity } from '@ai-agents-observability/auth';
import { issueAccessToken, issueRefreshToken } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { withRouteLogging } from '@/lib/api-logging';
import { getProvider } from '@/lib/auth-provider';
import { getConfig } from '@/lib/config';
import { ensureVisibilityPolicy } from '@/lib/ensure-visibility-policy';
import { logger } from '@/lib/logger';
import { type OAuthErrorCode, oauthErrorLocation } from '@/lib/oauth-errors';
import { oauthCallbackUrl, publicAppOrigin } from '@/lib/oauth-origin';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import {
  clearOAuthCookies,
  consumeNextCookie,
  getStateCookie,
  hashState,
  setAuthCookies,
} from '@/lib/session-cookie';
import { syncLoginTeams } from '@/lib/sync-login-teams';

async function oauthErrorResponse(code: OAuthErrorCode): Promise<NextResponse> {
  await clearOAuthCookies();
  return new NextResponse(null, {
    headers: { location: oauthErrorLocation(code, getRequestId()) },
    status: 302,
  });
}

export const GET = withRouteLogging('auth.callback', async (request: Request) => {
  try {
    const url = new URL(request.url);
    const { appBaseUrl, isProduction } = getConfig();
    const appOrigin = publicAppOrigin({
      appBaseUrl,
      isProduction,
      requestUrl: request.url,
    });
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      return await oauthErrorResponse('invalid_request');
    }

    const storedHash = await getStateCookie();
    if (!storedHash || storedHash !== hashState(state)) {
      logger.warn({ reqId: getRequestId() }, 'auth.callback.state_mismatch');
      return await oauthErrorResponse('invalid_state');
    }

    let identity: ExternalIdentity;
    try {
      identity = await getProvider().completeAuthorize({
        code,
        redirectUri: oauthCallbackUrl(appOrigin),
        state,
      });
    } catch (err) {
      logger.error({ err, reqId: getRequestId() }, 'auth.callback.oauth_exchange_failed');
      return await oauthErrorResponse('provider');
    }

    const db = getPrisma();
    const githubId = BigInt(identity.external_id);
    const user = await db.user.upsert({
      create: {
        displayName: identity.display_name,
        email: identity.email,
        githubId,
        githubLogin: (identity.raw as { login: string }).login,
        lastSeenAt: new Date(),
      },
      update: {
        displayName: identity.display_name,
        email: identity.email,
        lastSeenAt: new Date(),
      },
      where: { githubId },
    });

    await ensureVisibilityPolicy(db, user.id);

    // Sync the user's GitHub team membership at login so `/team/*` has data
    // immediately. Best-effort: a GitHub/API failure must not block sign-in.
    try {
      const memberships = await getProvider().fetchTeams(identity);
      await syncLoginTeams(db, user.id, memberships);
    } catch (err) {
      // non-fatal — the org-wide sync-teams cron will reconcile later
      logger.warn(
        { err, reqId: getRequestId(), userId: user.id },
        'auth.callback.team_sync_failed',
      );
    }

    const [access, refresh] = await Promise.all([
      issueAccessToken(user.id),
      issueRefreshToken(db, user.id),
    ]);

    await setAuthCookies(access, refresh);
    const next = await consumeNextCookie();
    return NextResponse.redirect(new URL(next ?? '/me', appOrigin));
  } catch (err) {
    logger.error({ err, reqId: getRequestId() }, 'auth.callback.unexpected_error');
    return await oauthErrorResponse('unexpected');
  }
});
