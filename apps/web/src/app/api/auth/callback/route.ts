import type { ExternalIdentity } from '@ai-agents-observability/auth';
import { issueAccessToken, issueRefreshToken } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { getProvider } from '@/lib/auth-provider';
import { ensureVisibilityPolicy } from '@/lib/ensure-visibility-policy';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { consumeNextCookie, getStateCookie, hashState, setAuthCookies } from '@/lib/session-cookie';
import { syncLoginTeams } from '@/lib/sync-login-teams';

export const GET = withRouteLogging('auth.callback', async (request: Request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return jsonError('Missing code or state', 400);
  }

  const storedHash = await getStateCookie();
  if (!storedHash || storedHash !== hashState(state)) {
    logger.warn({ reqId: getRequestId() }, 'auth.callback.state_mismatch');
    return jsonError('Invalid state', 400);
  }

  let identity: ExternalIdentity;
  try {
    identity = await getProvider().completeAuthorize({
      code,
      redirectUri: `${url.origin}/api/auth/callback`,
      state,
    });
  } catch (err) {
    logger.error({ err, reqId: getRequestId() }, 'auth.callback.oauth_exchange_failed');
    return jsonError('OAuth exchange failed', 502);
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
    logger.warn({ err, reqId: getRequestId(), userId: user.id }, 'auth.callback.team_sync_failed');
  }

  const [access, refresh] = await Promise.all([
    issueAccessToken(user.id),
    issueRefreshToken(db, user.id),
  ]);

  await setAuthCookies(access, refresh);
  const next = await consumeNextCookie();
  return NextResponse.redirect(new URL(next ?? '/me', url.origin));
});
