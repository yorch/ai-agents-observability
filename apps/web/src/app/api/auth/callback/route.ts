import { issueAccessToken, issueRefreshToken } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { NextResponse } from 'next/server';

import { provider } from '../../../../lib/auth-provider.js';
import { ensureVisibilityPolicy } from '../../../../lib/ensure-visibility-policy.js';
import { getStateCookie, hashState, setAuthCookies } from '../../../../lib/session-cookie.js';

const db = createClient(process.env.DATABASE_URL!);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  const storedHash = await getStateCookie();
  if (!storedHash || storedHash !== hashState(state)) {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
  }

  let identity;
  try {
    identity = await provider.completeAuthorize({ code, state });
  } catch {
    return NextResponse.json({ error: 'OAuth exchange failed' }, { status: 502 });
  }

  const githubId = BigInt(identity.external_id);
  const user = await db.user.upsert({
    where: { githubId },
    create: {
      githubLogin: (identity.raw as { login: string }).login,
      githubId,
      email: identity.email,
      displayName: identity.display_name,
      lastSeenAt: new Date(),
    },
    update: {
      email: identity.email,
      displayName: identity.display_name,
      lastSeenAt: new Date(),
    },
  });

  await ensureVisibilityPolicy(db, user.id);

  const [access, refresh] = await Promise.all([
    issueAccessToken(user.id),
    issueRefreshToken(db, user.id),
  ]);

  await setAuthCookies(access, refresh);
  return NextResponse.redirect(new URL('/me', url.origin));
}
