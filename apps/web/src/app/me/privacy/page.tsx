import { redirect } from 'next/navigation';
import { DeleteDataButton } from '../../../components/me/DeleteDataButton';
import { PrivacyForm } from '../../../components/me/PrivacyForm';
import { currentUser } from '../../../lib/auth';
import { getVisibilityPolicy } from '../../../lib/visibility';

export const dynamic = 'force-dynamic';

export default async function PrivacyPage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const policy = await getVisibilityPolicy(user.id);

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Privacy settings</h1>
        <p className="mt-1 text-sm text-white/50">
          Control what data is shared with your team and organization.
        </p>
      </div>

      {/* Sharing toggles */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white/70">Data sharing</h2>
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

      {/* Pause data collection */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white/70">Pause data collection</h2>
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2">
          <p className="text-sm text-white/70">
            Run the following command to temporarily pause telemetry from your local machine:
          </p>
          <pre className="rounded-md bg-black/30 px-4 py-3 text-sm font-mono text-white/80 overflow-x-auto">
            claude-telemetry pause
          </pre>
          <p className="text-xs text-white/40">
            Run <code className="font-mono">claude-telemetry resume</code> to re-enable.
          </p>
        </div>
      </section>

      {/* Danger zone */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-red-400">Danger zone</h2>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
          <p className="text-sm text-white/70">
            Request permanent deletion of all your data. This action cannot be undone. Your account,
            sessions, and transcripts will be scheduled for deletion.
          </p>
          <DeleteDataButton />
        </div>
      </section>
    </div>
  );
}
