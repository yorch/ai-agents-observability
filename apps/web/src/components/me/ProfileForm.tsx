'use client';

import { useState, useTransition } from 'react';
import { saveProfile } from '@/app/me/settings/profile/actions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Field';
import { useDict } from '@/i18n/provider';

type Props = {
  initialDisplayName: string | null;
  initialEmail: string | null;
  githubLogin: string | null;
};

export function ProfileForm({ initialDisplayName, initialEmail, githubLogin }: Props) {
  const dict = useDict();
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
    <Card contentClassName="space-y-4">
      {githubLogin && (
        <div className="space-y-1">
          <p className="block text-xs font-medium text-text-2">GitHub login</p>
          <p className="text-sm text-text-2 font-mono">{githubLogin}</p>
          <p className="text-xs text-text-3">Set by GitHub OAuth — not editable here.</p>
        </div>
      )}

      <Field label={dict.me.settings.profile.displayName} htmlFor="displayName">
        <Input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setStatus(null);
          }}
          maxLength={120}
          placeholder={dict.me.settings.profile.displayNamePlaceholder}
        />
      </Field>

      <Field
        label={dict.me.settings.profile.email}
        htmlFor="email"
        hint="Overrides the email synced from GitHub. Leave blank to use your GitHub email."
      >
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setStatus(null);
          }}
          placeholder={dict.me.settings.profile.emailPlaceholder}
        />
      </Field>

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
