'use client';

import { createContext, useContext } from 'react';

import type { Locale } from './config';
import type { Dictionary } from './dictionary';

interface I18nValue {
  dict: Dictionary;
  locale: Locale;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  dict,
  locale,
  children,
}: I18nValue & { children: React.ReactNode }) {
  return <I18nContext.Provider value={{ dict, locale }}>{children}</I18nContext.Provider>;
}

const useI18n = (): I18nValue => {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useDict/useLocale must be used within I18nProvider');
  }
  return value;
};

/** Translations for client components. */
export const useDict = (): Dictionary => useI18n().dict;

export const useLocale = (): Locale => useI18n().locale;
