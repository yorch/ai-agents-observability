'use client';
import { useState, useTransition } from 'react';

import { saveProfile } from '@/app/me/settings/profile/actions';

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
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
      {githubLogin && (
        <div className="space-y-1">
          <p className="block text-xs font-medium text-white/50">GitHub login</p>
          <p className="text-sm text-white/70 font-mono">{githubLogin}</p>
          <p className="text-xs text-white/30">Set by GitHub OAuth — not editable here.</p>
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="displayName" className="block text-xs font-medium text-white/70">
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
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="email" className="block text-xs font-medium text-white/70">
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
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <p className="text-xs text-white/30">
          Overrides the email synced from GitHub. Leave blank to use your GitHub email.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium hover:bg-brand-600 transition-colors disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save profile'}
        </button>
        {status && (
          <span className={`text-sm ${status.ok ? 'text-green-400' : 'text-red-400'}`}>
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}
