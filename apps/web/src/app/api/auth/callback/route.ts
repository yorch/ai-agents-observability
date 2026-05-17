import { createHash } from 'node:crypto';
import { GitHubProvider, issueAccessToken, issueRefreshToken } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { NextResponse } from 'next/server';

import { getStateCookie, setAuthCookies } from '../../../../lib/session-cookie.js';

const db = createClient(process.env.DATABASE_URL!);

function getProvider() {
  return new GitHubProvider({
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID!,
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  // Verify state against cookie
  const storedHash = await getStateCookie();
  const expectedHash = createHash('sha256').update(state).digest('hex');
  if (!storedHash || storedHash !== expectedHash) {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
  }

  const provider = getProvider();
  let identity;
  try {
    identity = await provider.completeAuthorize({ code, state });
  } catch {
    return NextResponse.json({ error: 'OAuth exchange failed' }, { status: 502 });
  }

  // Upsert user
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

  // Ensure VisibilityPolicy exists with privacy-preserving defaults
  await db.visibilityPolicy.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
  });

  const [access, refresh] = await Promise.all([
    issueAccessToken(user.id),
    issueRefreshToken(db, user.id),
  ]);

  await setAuthCookies(access, refresh);

  return NextResponse.redirect(new URL('/me', url.origin));
}
