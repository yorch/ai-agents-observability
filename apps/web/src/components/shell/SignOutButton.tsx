'use client';

import { useTransition } from 'react';

import { SignOutIcon } from '@/components/icons';
import { useDict } from '@/i18n/provider';

/**
 * Sign-out. Lives in the rail footer beside the account identity — it was
 * previously the last item of the dropdown the rail replaced.
 */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();
  const dict = useDict();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await fetch('/api/auth/logout', { method: 'POST' });
          window.location.href = '/login';
        })
      }
      className="min-h-11 min-w-11 text-text-3 transition-colors hover:text-text-2 disabled:opacity-50"
      title={dict.rail.signOut}
      aria-label={dict.rail.signOut}
    >
      <SignOutIcon size={15} />
    </button>
  );
}
