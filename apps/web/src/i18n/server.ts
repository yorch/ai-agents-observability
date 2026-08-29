import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from './config';
import { DICTIONARIES, type Dictionary } from './dictionary';

/** The active locale from the cookie (defaults to English). Cached per request. */
export const getLocale = cache(async (): Promise<Locale> => {
  const jar = await cookies();
  const value = jar.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
});

export const getDictionary = (locale: Locale): Dictionary => DICTIONARIES[locale];

export interface Translations {
  dict: Dictionary;
  locale: Locale;
}

/** One-stop translations bundle for server components and actions. */
export const getTranslations = cache(async (): Promise<Translations> => {
  const locale = await getLocale();
  return { dict: getDictionary(locale), locale };
});
