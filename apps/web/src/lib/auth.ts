import { verifyAccessToken } from '@ai-agents-observability/auth';
import type { User } from '@ai-agents-observability/db';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getPrisma } from './prisma';
import { COOKIE_ACCESS, sanitizeNext } from './session-cookie';

/** Mirrors `PATHNAME_HEADER` in `src/proxy.ts`, which sets it on every gated request. */
const PATHNAME_HEADER = 'x-pathname';

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_ACCESS)?.value;
  if (!token) {
    return null;
  }

  let userId: string;
  try {
    ({ userId } = await verifyAccessToken(token));
  } catch {
    return null;
  }

  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  if (!user || user.deactivatedAt) {
    return null;
  }
  return user;
}

/**
 * Sends an unauthenticated viewer to /login, carrying the page they asked for
 * as `?next=` so signing in returns them to it. Use instead of a bare
 * `redirect('/login')` — which drops the deep link — in any page, layout or
 * server action that finds no `currentUser()`.
 *
 * The proxy covers the no-cookie case itself; this covers the cookie that is
 * present but expired or revoked, which only `currentUser()` can detect. The
 * path comes from the header the proxy sets, and is re-sanitised so only a
 * same-origin relative path is ever echoed into the redirect.
 */
export async function redirectToLogin(): Promise<never> {
  const next = sanitizeNext((await headers()).get(PATHNAME_HEADER));
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
}
