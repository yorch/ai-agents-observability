import { cookies } from 'next/headers';

const IS_PROD = process.env.NODE_ENV === 'production';

export const COOKIE_ACCESS = 'cc_access';
export const COOKIE_REFRESH = 'cc_refresh';
export const COOKIE_STATE = 'cc_oauth_state';

export async function setAuthCookies(access: string, refresh: string) {
  const jar = await cookies();
  jar.set(COOKIE_ACCESS, access, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60, // 15 min — matches JWT TTL
  });
  jar.set(COOKIE_REFRESH, refresh, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/api/auth/refresh',
    maxAge: 90 * 24 * 60 * 60, // 90 days
  });
}

export async function clearAuthCookies() {
  const jar = await cookies();
  jar.delete(COOKIE_ACCESS);
  jar.delete(COOKIE_REFRESH);
}

export async function setStateCookie(stateHash: string) {
  const jar = await cookies();
  jar.set(COOKIE_STATE, stateHash, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/api/auth/callback',
    maxAge: 10 * 60, // 10 min
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
