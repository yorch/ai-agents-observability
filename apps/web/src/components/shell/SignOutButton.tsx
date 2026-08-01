'use client';

import { useTransition } from 'react';

import { SignOutIcon } from '@/components/icons';

/**
 * Sign-out. Lives in the rail footer beside the account identity — it was
 * previously the last item of the dropdown the rail replaced.
 */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();

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
      className="text-text-3 transition-colors hover:text-text-2 disabled:opacity-50"
      title="Sign out"
      aria-label="Sign out"
    >
      <SignOutIcon size={15} />
    </button>
  );
}
