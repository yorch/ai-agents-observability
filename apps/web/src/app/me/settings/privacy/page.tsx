import { redirect } from 'next/navigation';
import { DeleteDataButton } from '@/components/me/DeleteDataButton';
import { PrivacyForm } from '@/components/me/PrivacyForm';
import { currentUser } from '@/lib/auth';
import { getVisibilityPolicy } from '@/lib/visibility';

export const dynamic = 'force-dynamic';

export default async function SettingsPrivacyPage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const policy = await getVisibilityPolicy(user.id);

  return (
    <div className="space-y-8 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Privacy</h2>
        <p className="mt-0.5 text-sm text-text-2">
          Control what data is shared with your team and organization.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-2">Data sharing</h3>
        <PrivacyForm
          initialPolicy={
            policy
              ? {
                  shareMetadataWithOrg: policy.shareMetadataWithOrg,
                  shareMetadataWithTeam: policy.shareMetadataWithTeam,
                  shareTranscriptsWithOrg: policy.shareTranscriptsWithOrg,
                  shareTranscriptsWithTeam: policy.shareTranscriptsWithTeam,
                }
              : null
          }
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-2">Pause data collection</h3>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-2">
          <p className="text-sm text-text-2">
            Run the following command to temporarily pause telemetry from your local machine:
          </p>
          <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
            claude-telemetry pause
          </pre>
          <p className="text-xs text-text-3">
            Run <code className="font-mono">claude-telemetry resume</code> to re-enable.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-red-400">Danger zone</h3>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
          <p className="text-sm text-text-2">
            Request permanent deletion of all your data. This action cannot be undone. Your account,
            sessions, and transcripts will be scheduled for deletion.
          </p>
          <DeleteDataButton />
        </div>
      </section>
    </div>
  );
}
