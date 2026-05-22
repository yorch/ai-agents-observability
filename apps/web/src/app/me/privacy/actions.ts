'use server';
import { currentUser } from '../../../lib/auth';
import { updateVisibilityPolicy } from '../../../lib/visibility';

export async function savePrivacySettings(formData: FormData) {
  const user = await currentUser();
  if (!user) throw new Error('Unauthorized');

  await updateVisibilityPolicy(user.id, {
    shareMetadataWithOrg: formData.get('shareMetadataWithOrg') === 'true',
    shareMetadataWithTeam: formData.get('shareMetadataWithTeam') === 'true',
    shareTranscriptsWithOrg: formData.get('shareTranscriptsWithOrg') === 'true',
    shareTranscriptsWithTeam: formData.get('shareTranscriptsWithTeam') === 'true',
  });
}
