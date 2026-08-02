'use client';

import { useState, useTransition } from 'react';
import { saveProfile } from '@/app/me/settings/profile/actions';
import { Button, Card } from '@/components/ui';

type Props = {
  initialDisplayName: string | null;
  initialEmail: string | null;
  githubLogin: string | null;
};

export function ProfileForm({ initialDisplayName, initialEmail, githubLogin }: Props) {
  const [isPending, startTransition] = useTransition();
  const [displayName, setDisplayName] = useState(initialDisplayName ?? '');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  function handleSave() {
    setStatus(null);
    const formData = new FormData();
    formData.set('displayName', displayName);
    formData.set('email', email);

    startTransition(async () => {
      const result = await saveProfile(formData);
      if (result.ok) {
        setStatus({ message: 'Saved', ok: true });
      } else {
        setStatus({ message: result.error, ok: false });
      }
    });
  }

  return (
    <Card className="space-y-4">
      {githubLogin && (
        <div className="space-y-1">
          <p className="block text-xs font-medium text-text-2">GitHub login</p>
          <p className="text-sm text-text-2 font-mono">{githubLogin}</p>
          <p className="text-xs text-text-3">Set by GitHub OAuth — not editable here.</p>
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="displayName" className="block text-xs font-medium text-text-2">
          Display name
        </label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setStatus(null);
          }}
          maxLength={120}
          placeholder="Your name"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="email" className="block text-xs font-medium text-text-2">
          Email address
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setStatus(null);
          }}
          placeholder="you@example.com"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <p className="text-xs text-text-3">
          Overrides the email synced from GitHub. Leave blank to use your GitHub email.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save profile'}
        </Button>
        {status && (
          <span className={`text-sm ${status.ok ? 'text-good' : 'text-crit'}`}>
            {status.message}
          </span>
        )}
      </div>
    </Card>
  );
}
