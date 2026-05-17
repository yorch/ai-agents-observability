import { createHash } from 'node:crypto';
import { GitHubProvider } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { setStateCookie } from '../../../../lib/session-cookie.js';

function getProvider() {
  return new GitHubProvider({
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID!,
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
  });
}

function buildCallbackUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/api/auth/callback`;
}

export async function GET(request: Request) {
  const provider = getProvider();
  const { state, url } = await provider.startAuthorize(buildCallbackUrl(request));

  // Store hash of state in cookie; send raw state in URL
  const stateHash = createHash('sha256').update(state).digest('hex');
  await setStateCookie(stateHash);

  return NextResponse.redirect(url);
}
