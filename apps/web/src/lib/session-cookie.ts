import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';

import { COOKIE_ACCESS, COOKIE_NEXT, COOKIE_REFRESH, COOKIE_STATE } from './cookie-names';

export { COOKIE_ACCESS, COOKIE_NEXT, COOKIE_REFRESH, COOKIE_STATE };

const IS_PROD = process.env.NODE_ENV === 'production';

// Only same-origin absolute paths are accepted as post-login redirects.
// `//evil.example` and `https://...` are common open-redirect vectors;
// requiring a `/` prefix and rejecting `//` shuts them down.
export function sanitizeNext(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  return value;
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export async function setAuthCookies(access: string, refresh: string) {
  const jar = await cookies();
  jar.set(COOKIE_ACCESS, access, {
    httpOnly: true,
    maxAge: 15 * 60,
    path: '/',
    sameSite: 'lax',
    secure: IS_PROD,
  });
  jar.set(COOKIE_REFRESH, refresh, {
    httpOnly: true,
    maxAge: 90 * 24 * 60 * 60,
    path: '/api/auth/refresh',
    sameSite: 'lax',
    secure: IS_PROD,
  });
}

export async function clearAuthCookies() {
  const jar = await cookies();
  jar.delete(COOKIE_ACCESS);
  jar.set(COOKIE_REFRESH, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/api/auth/refresh',
    sameSite: 'lax',
    secure: IS_PROD,
  });
}

export async function setStateCookie(stateHash: string) {
  const jar = await cookies();
  jar.set(COOKIE_STATE, stateHash, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: '/api/auth/callback',
    sameSite: 'lax',
    secure: IS_PROD,
  });
}

export async function getStateCookie(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(COOKIE_STATE)?.value;
}

export async function setNextCookie(next: string) {
  const jar = await cookies();
  jar.set(COOKIE_NEXT, next, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: '/api/auth/callback',
    sameSite: 'lax',
    secure: IS_PROD,
  });
}

export async function consumeNextCookie(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(COOKIE_NEXT)?.value;
  if (value) {
    jar.set(COOKIE_NEXT, '', {
      httpOnly: true,
      maxAge: 0,
      path: '/api/auth/callback',
      sameSite: 'lax',
      secure: IS_PROD,
    });
  }
  return sanitizeNext(value);
}

export async function getRefreshCookie(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(COOKIE_REFRESH)?.value;
}
