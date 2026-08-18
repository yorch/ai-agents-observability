'use server';
import { withActionResult } from '@/lib/action-result';
import { currentUser } from '@/lib/auth';
import { updateVisibilityPolicy } from '@/lib/visibility';

// These are the settings that gate who can see the user's data — a failure
// here must never render as "Saved". The wrapper turns an unexpected throw
// into an inline error.
export const savePrivacySettings = withActionResult(async (formData) => {
  const user = await currentUser();
  if (!user) {
    return { error: 'Your session has expired — sign in again to save.', ok: false };
  }

  await updateVisibilityPolicy(user.id, {
    shareMetadataWithOrg: formData.get('shareMetadataWithOrg') === 'true',
    shareMetadataWithTeam: formData.get('shareMetadataWithTeam') === 'true',
    shareTranscriptsWithOrg: formData.get('shareTranscriptsWithOrg') === 'true',
    shareTranscriptsWithTeam: formData.get('shareTranscriptsWithTeam') === 'true',
  });
  return { ok: true };
});
