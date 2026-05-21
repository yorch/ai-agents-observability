'use client';

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
      <span className="text-white/80">{displayName}</span>
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
