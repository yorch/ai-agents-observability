import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { COOKIE_ACCESS } from './lib/cookie-names';

export function proxy(req: NextRequest) {
  const token = req.cookies.get(COOKIE_ACCESS)?.value;
  if (token) {
    return NextResponse.next();
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

// Proxy only does the cookie-presence check — full verification happens
// in server components via `currentUser()`. Avoids running node:crypto at the edge.
export const config = {
  matcher: ['/me/:path*'],
};
