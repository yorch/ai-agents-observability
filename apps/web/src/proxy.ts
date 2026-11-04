import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { COOKIE_ACCESS } from './lib/cookie-names';

/**
 * Request header carrying the requested path + query to server components.
 * A page has no other way to learn its own URL, and `redirectToLogin()` needs
 * it so a cookie that is present but no longer valid still round-trips the
 * deep link through /login. Set here, so a client-sent value is overwritten.
 */
export const PATHNAME_HEADER = 'x-pathname';

export function proxy(req: NextRequest) {
  const destination = req.nextUrl.pathname + req.nextUrl.search;
  const token = req.cookies.get(COOKIE_ACCESS)?.value;
  if (token) {
    const headers = new Headers(req.headers);
    headers.set(PATHNAME_HEADER, destination);
    return NextResponse.next({ request: { headers } });
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', destination);
  return NextResponse.redirect(loginUrl);
}

// Proxy only does the cookie-presence check — full verification happens
// in server components via `currentUser()`. Avoids running node:crypto at the edge.
export const config = {
  matcher: ['/me/:path*', '/team/:path*', '/org/:path*', '/admin/:path*'],
};
