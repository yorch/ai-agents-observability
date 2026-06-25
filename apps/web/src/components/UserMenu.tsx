'use client';

import Link from 'next/link';
import { useTransition } from 'react';

export function UserMenu({ displayName }: { displayName: string }) {
  const [pending, startTransition] = useTransition();

  const signOut = () => {
    startTransition(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  };

  return (
    <div className="flex items-center gap-3">
      <Link href="/me" className="text-sm text-text-2 hover:text-text transition-colors">
        {displayName}
      </Link>
      <Link href="/install" className="text-xs text-text-3 hover:text-text-2 transition-colors">
        Install
      </Link>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="text-xs text-text-3 hover:text-text-2 transition-colors disabled:opacity-40"
      >
        {pending ? 'signing out…' : 'sign out'}
      </button>
    </div>
  );
}
