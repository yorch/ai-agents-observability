'use client';

import { useTransition } from 'react';

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
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M6.2 13.5H3.6a1.4 1.4 0 0 1-1.4-1.4V3.9a1.4 1.4 0 0 1 1.4-1.4h2.6M10.4 11.1 13.5 8l-3.1-3.1M13.5 8H6.2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
