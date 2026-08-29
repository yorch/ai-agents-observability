'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Select } from '@/components/ui/Field';
import { LOCALE_NAMES, LOCALES, type Locale } from '@/i18n/config';
import { useDict, useLocale } from '@/i18n/provider';
import { setLocale } from '@/i18n/switch-locale';

/**
 * Locale picker for the rail footer. Sets the locale cookie via a server
 * action, then refreshes so server components re-read the cookie.
 */
export function LocaleSwitcher() {
  const router = useRouter();
  const dict = useDict();
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      size="sm"
      className="min-h-11 w-auto"
      disabled={isPending}
      aria-label={dict.common.selectLanguage}
      value={locale}
      onChange={(e) => {
        const next = e.target.value as Locale;
        startTransition(async () => {
          await setLocale(next);
          router.refresh();
        });
      }}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </Select>
  );
}
