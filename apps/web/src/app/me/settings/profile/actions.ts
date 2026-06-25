'use server';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

export type ProfileUpdateResult =
  | { ok: true }
  | { ok: false; error: string };

export async function saveProfile(formData: FormData): Promise<ProfileUpdateResult> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, error: 'Unauthorized' };
  }

  const displayName = (formData.get('displayName') as string | null)?.trim() ?? '';
  const email = (formData.get('email') as string | null)?.trim() ?? '';

  if (displayName.length > 120) {
    return { ok: false, error: 'Display name must be 120 characters or fewer.' };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }

  try {
    await getPrisma().user.update({
      where: { id: user.id },
      data: {
        displayName: displayName || null,
        email: email || null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unique constraint') || msg.includes('unique constraint')) {
      return { ok: false, error: 'That email is already used by another account.' };
    }
    return { ok: false, error: 'Failed to save. Please try again.' };
  }

  return { ok: true };
}
