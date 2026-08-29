import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from './i18n/config';
import { COOKIE_ACCESS } from './lib/cookie-names';

export function proxy(req: NextRequest) {
  // Locale detection: if the locale cookie is missing or invalid, set it
  // from the Accept-Language header. This runs once at the edge so server
  // components can just read the cookie via `getLocale()`.
  const localeCookie = req.cookies.get(LOCALE_COOKIE)?.value;
  const needsLocaleCookie = !isLocale(localeCookie);
  const locale = needsLocaleCookie
    ? negotiateLocale(req.headers.get('accept-language') ?? '')
    : localeCookie;

  // Auth check — cookie-presence only (full verification in `currentUser()`).
  const token = req.cookies.get(COOKIE_ACCESS)?.value;
  if (!token) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', req.nextUrl.pathname);
    const redirect = NextResponse.redirect(loginUrl);
    if (needsLocaleCookie) {
      redirect.cookies.set(LOCALE_COOKIE, locale, {
        maxAge: 60 * 60 * 24 * 365,
        path: '/',
        sameSite: 'lax',
      });
    }
    return redirect;
  }

  if (needsLocaleCookie) {
    const res = NextResponse.next();
    res.cookies.set(LOCALE_COOKIE, locale, {
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
      sameSite: 'lax',
    });
    return res;
  }

  return NextResponse.next();
}

/** Parse Accept-Language and return the best matching locale. */
function negotiateLocale(acceptLanguage: string): string {
  const parsed = acceptLanguage
    .split(',')
    .map((part) => {
      const segments = part.trim().split(';');
      const tag = segments[0] ?? '';
      const qParam = segments.slice(1).find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.split('=')[1] ?? '1') : 1;
      return { q, tag: tag.toLowerCase() };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of parsed) {
    if (!tag) {
      continue;
    }
    // Exact match (e.g. "es")
    if (isLocale(tag)) {
      return tag;
    }
    // Prefix match (e.g. "es-ES" → "es", "en-US" → "en")
    const prefix = tag.split('-')[0];
    if (isLocale(prefix)) {
      return prefix;
    }
  }

  return DEFAULT_LOCALE;
}

// Proxy only does the cookie-presence check — full verification happens
// in server components via `currentUser()`. Avoids running node:crypto at the edge.
// The matcher covers all authenticated routes plus public routes so the locale
// cookie is set on first visit regardless of entry point.
export const config = {
  matcher: ['/me/:path*', '/team/:path*', '/org/:path*', '/admin/:path*', '/login', '/install'],
};
