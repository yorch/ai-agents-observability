'use client';
import { useState, useTransition } from 'react';

import { savePrivacySettings } from '@/app/me/settings/privacy/actions';
import { Button, Card } from '@/components/ui';

type Toggle = {
  description: string;
  label: string;
  name: string;
  value: boolean;
};

function ToggleRow({
  toggle,
  onChange,
}: {
  toggle: Toggle;
  onChange: (name: string, value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-border-subtle last:border-0">
      <div className="flex-1">
        <p className="text-sm font-medium">{toggle.label}</p>
        <p className="mt-0.5 text-xs text-text-2">{toggle.description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={toggle.value}
        onClick={() => onChange(toggle.name, !toggle.value)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-transparent ${
          toggle.value ? 'border-accent bg-accent' : 'border-border-strong bg-surface-2'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-text shadow ring-0 transition-transform mt-0.5 ${
            toggle.value ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

type InitialPolicy = {
  shareMetadataWithOrg: boolean;
  shareMetadataWithTeam: boolean;
  shareTranscriptsWithOrg: boolean;
  shareTranscriptsWithTeam: boolean;
};

export function PrivacyForm({ initialPolicy }: { initialPolicy: InitialPolicy | null }) {
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [policy, setPolicy] = useState<InitialPolicy>({
    shareMetadataWithOrg: initialPolicy?.shareMetadataWithOrg ?? true,
    shareMetadataWithTeam: initialPolicy?.shareMetadataWithTeam ?? true,
    shareTranscriptsWithOrg: initialPolicy?.shareTranscriptsWithOrg ?? false,
    shareTranscriptsWithTeam: initialPolicy?.shareTranscriptsWithTeam ?? false,
  });

  const toggles: Toggle[] = [
    {
      description:
        'Allow your team members to see session metadata (duration, cost, repo) but not transcripts.',
      label: 'Share metadata with team',
      name: 'shareMetadataWithTeam',
      value: policy.shareMetadataWithTeam,
    },
    {
      description: 'Allow your organization admins to see session metadata in org-level reports.',
      label: 'Share metadata with org',
      name: 'shareMetadataWithOrg',
      value: policy.shareMetadataWithOrg,
    },
    {
      description:
        'Allow team members to read your session transcripts (full conversation content).',
      label: 'Share transcripts with team',
      name: 'shareTranscriptsWithTeam',
      value: policy.shareTranscriptsWithTeam,
    },
    {
      description:
        'Allow organization admins to read your session transcripts in org-level reports.',
      label: 'Share transcripts with org',
      name: 'shareTranscriptsWithOrg',
      value: policy.shareTranscriptsWithOrg,
    },
  ];

  function handleToggle(name: string, value: boolean) {
    setPolicy((prev) => ({ ...prev, [name]: value }));
    setSaved(false);
  }

  function handleSave() {
    const formData = new FormData();
    formData.set('shareMetadataWithTeam', policy.shareMetadataWithTeam.toString());
    formData.set('shareMetadataWithOrg', policy.shareMetadataWithOrg.toString());
    formData.set('shareTranscriptsWithTeam', policy.shareTranscriptsWithTeam.toString());
    formData.set('shareTranscriptsWithOrg', policy.shareTranscriptsWithOrg.toString());

    startTransition(async () => {
      await savePrivacySettings(formData);
      setSaved(true);
    });
  }

  return (
    <Card>
      <div className="divide-y divide-border-subtle">
        {toggles.map((toggle) => (
          <ToggleRow key={toggle.name} toggle={toggle} onChange={handleToggle} />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save settings'}
        </Button>
        {saved && <span className="text-sm text-good">Saved</span>}
      </div>
    </Card>
  );
}
