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

    const form = e.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement).value;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;

    try {
      const res = await fetch('/api/auth/password', {
        body: JSON.stringify({ email, next, password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      if (res.ok) {
        const { redirect } = (await res.json()) as { redirect: string };
        router.push(redirect);
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
    <form onSubmit={handleSubmit} className="space-y-3 text-left">
      <div>
        <label htmlFor="email" className="block text-xs font-medium text-white/70 mb-1">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-xs font-medium text-white/70 mb-1">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="••••••••"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full inline-flex items-center justify-center rounded-md bg-white/10 px-4 py-2 text-sm font-medium text-white shadow hover:bg-white/20 disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in with email'}
      </button>
    </form>
  );
}
