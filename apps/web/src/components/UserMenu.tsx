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
      <Link href="/me" className="text-white/80 hover:text-white">
        {displayName}
      </Link>
      <Link href="/install" className="text-xs text-white/40 hover:text-white/70">
        Install
      </Link>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
