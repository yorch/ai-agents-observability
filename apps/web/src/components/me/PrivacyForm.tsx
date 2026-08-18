'use client';
import { useState } from 'react';

import { savePrivacySettings } from '@/app/me/settings/privacy/actions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useActionResult } from '@/lib/use-action-result';

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
  allowJudgeAnalysis: boolean;
  shareMetadataWithOrg: boolean;
  shareMetadataWithTeam: boolean;
  shareTranscriptsWithOrg: boolean;
  shareTranscriptsWithTeam: boolean;
};

export function PrivacyForm({ initialPolicy }: { initialPolicy: InitialPolicy | null }) {
  const { error, isPending, reset, run, saved } = useActionResult();
  const [policy, setPolicy] = useState<InitialPolicy>({
    allowJudgeAnalysis: initialPolicy?.allowJudgeAnalysis ?? false,
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
    // P13-009. Deliberately its own consent rather than an implication of the
    // sharing toggles above: an automated reader is a different question from a
    // human one, and the results are visible only to you either way.
    {
      description:
        'Allow an automated evaluator to read your transcripts and label your sessions. Results are visible only to you, and every read appears in your audit log.',
      label: 'Allow automated session evaluation',
      name: 'allowJudgeAnalysis',
      value: policy.allowJudgeAnalysis,
    },
  ];

  function handleToggle(name: string, value: boolean) {
    setPolicy((prev) => ({ ...prev, [name]: value }));
    reset();
  }

  function handleSave() {
    const formData = new FormData();
    formData.set('shareMetadataWithTeam', policy.shareMetadataWithTeam.toString());
    formData.set('shareMetadataWithOrg', policy.shareMetadataWithOrg.toString());
    formData.set('shareTranscriptsWithTeam', policy.shareTranscriptsWithTeam.toString());
    formData.set('shareTranscriptsWithOrg', policy.shareTranscriptsWithOrg.toString());
    formData.set('allowJudgeAnalysis', policy.allowJudgeAnalysis.toString());

    run(() => savePrivacySettings(formData));
  }

  return (
    <Card>
      <div className="divide-y divide-border-subtle">
        {toggles.map((toggle) => (
          <ToggleRow key={toggle.name} toggle={toggle} onChange={handleToggle} />
        ))}
      </div>

      {/* The plain-language consequence of the toggles as currently set —
          the strongest trust signal is being able to see exactly what a team
          lead or org admin gets before pressing save. */}
      <div className="mt-4 rounded-md border border-border-subtle bg-surface-2 p-3">
        <p className="text-xs font-semibold text-text-2">With these settings, right now:</p>
        <ul className="mt-2 space-y-1 text-xs text-text-3">
          <li>
            Team leads {policy.shareMetadataWithTeam ? 'can see' : 'cannot see'} your session
            metadata (cost, duration, repo, tool counts).
          </li>
          <li>
            Team leads {policy.shareTranscriptsWithTeam ? 'can read' : 'cannot read'} your
            transcripts.
          </li>
          <li>
            Your sessions {policy.shareMetadataWithOrg ? 'contribute to' : 'are excluded from'}{' '}
            org-wide aggregate dashboards.
          </li>
          <li>
            Org admins{' '}
            {policy.shareTranscriptsWithOrg
              ? 'can read your transcripts without a per-view justification.'
              : 'can only read a transcript with a logged justification or an approved, time-boxed grant.'}
          </li>
          <li>
            Every privileged view of your data is recorded in{' '}
            <a href="/me/settings/audit" className="underline hover:text-text-2">
              your audit log
            </a>
            .
          </li>
        </ul>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save settings'}
        </Button>
        {saved && <span className="text-sm text-good">Saved</span>}
        {error && (
          <span role="alert" className="text-sm text-crit">
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}
