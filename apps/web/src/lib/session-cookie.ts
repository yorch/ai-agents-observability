import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';

const IS_PROD = process.env.NODE_ENV === 'production';

export const COOKIE_ACCESS = 'cc_access';
export const COOKIE_REFRESH = 'cc_refresh';
export const COOKIE_STATE = 'cc_oauth_state';

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

export async function getRefreshCookie(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(COOKIE_REFRESH)?.value;
}
