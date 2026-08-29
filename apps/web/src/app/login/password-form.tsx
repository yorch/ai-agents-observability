'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { useDict } from '@/i18n/provider';

type Props = { next?: string };

export function PasswordForm({ next }: Props) {
  const router = useRouter();
  const dict = useDict();
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
        setError(msg ?? dict.login.signInFailed);
      }
    } catch {
      setError(dict.login.networkError);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Field label={dict.login.email} htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder={dict.login.emailPlaceholder}
        />
      </Field>
      <Field label={dict.login.password} htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder={dict.login.passwordPlaceholder}
        />
      </Field>
      {error && <p className="text-xs text-crit">{error}</p>}
      <Button type="submit" variant="secondary" disabled={pending} className="w-full">
        {pending ? dict.login.signingIn : dict.login.signInWithEmail}
      </Button>
    </form>
  );
}
