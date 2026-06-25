'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Props = { next?: string };

export function PasswordForm({ next }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    const data = new FormData(e.currentTarget);
    const email = data.get('email') as string;
    const password = data.get('password') as string;

    try {
      const res = await fetch('/api/auth/password', {
        body: JSON.stringify({ email, next, password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      if (res.ok) {
        const { redirect } = (await res.json()) as { redirect?: string };
        router.push(redirect ?? '/me');
        router.refresh();
      } else {
        const { error: msg } = (await res.json()) as { error: string };
        setError(msg ?? 'Sign in failed');
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="email" className="block text-xs font-medium text-text-2 mb-1.5">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder-text-3 transition-colors focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-xs font-medium text-text-2 mb-1.5">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder-text-3 transition-colors focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="••••••••"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in with email'}
      </button>
    </form>
  );
}
