'use server';
import { currentUser } from '@/lib/auth';
import { updateVisibilityPolicy } from '@/lib/visibility';

export type SavePrivacyResult = { ok: true } | { error: string };

export async function savePrivacySettings(formData: FormData): Promise<SavePrivacyResult> {
  const user = await currentUser();
  if (!user) {
    return { error: 'Your session has expired — sign in again to save.' };
  }

  try {
    await updateVisibilityPolicy(user.id, {
      shareMetadataWithOrg: formData.get('shareMetadataWithOrg') === 'true',
      shareMetadataWithTeam: formData.get('shareMetadataWithTeam') === 'true',
      shareTranscriptsWithOrg: formData.get('shareTranscriptsWithOrg') === 'true',
      shareTranscriptsWithTeam: formData.get('shareTranscriptsWithTeam') === 'true',
    });
  } catch {
    // These are the settings that gate who can see the user's data — a silent
    // failure here must never render as "Saved".
    return { error: 'Could not save your settings. Try again.' };
  }
  return { ok: true };
}
