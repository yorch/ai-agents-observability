'use server';

import { cookies } from 'next/headers';

import { isLocale, LOCALE_COOKIE, type Locale } from './config';

/**
 * Sets the locale cookie and triggers a re-render. Called from the
 * LocaleSwitcher client component; `router.refresh()` on the client side
 * re-fetches server components with the new cookie value.
 */
export async function setLocale(value: string): Promise<void> {
  if (!isLocale(value)) {
    throw new Error(`Invalid locale: ${value}`);
  }
  const jar = await cookies();
  jar.set(LOCALE_COOKIE, value as Locale, {
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
  });
}
