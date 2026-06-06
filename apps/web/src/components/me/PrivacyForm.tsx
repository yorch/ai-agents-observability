'use client';
import { useState, useTransition } from 'react';

import { savePrivacySettings } from '@/app/me/privacy/actions';

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
    <div className="flex items-start justify-between gap-4 py-4 border-b border-white/5 last:border-0">
      <div className="flex-1">
        <p className="text-sm font-medium">{toggle.label}</p>
        <p className="mt-0.5 text-xs text-white/50">{toggle.description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={toggle.value}
        onClick={() => onChange(toggle.name, !toggle.value)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-transparent ${
          toggle.value ? 'border-brand-500 bg-brand-500' : 'border-white/20 bg-white/10'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform mt-0.5 ${
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
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="divide-y divide-white/5">
        {toggles.map((toggle) => (
          <ToggleRow key={toggle.name} toggle={toggle} onChange={handleToggle} />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium hover:bg-brand-600 transition-colors disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="text-sm text-green-400">Saved</span>}
      </div>
    </div>
  );
}
