'use server';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

export type ProfileUpdateResult = { ok: true } | { ok: false; error: string };

export async function saveProfile(formData: FormData): Promise<ProfileUpdateResult> {
  const user = await currentUser();
  if (!user) {
    return { error: 'Unauthorized', ok: false };
  }

  const displayName = (formData.get('displayName') as string | null)?.trim() ?? '';
  const email = (formData.get('email') as string | null)?.trim() ?? '';

  if (displayName.length > 120) {
    return { error: 'Display name must be 120 characters or fewer.', ok: false };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Enter a valid email address.', ok: false };
  }

  try {
    await getPrisma().user.update({
      data: {
        displayName: displayName || null,
        email: email || null,
      },
      where: { id: user.id },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unique constraint') || msg.includes('unique constraint')) {
      return { error: 'That email is already used by another account.', ok: false };
    }
    return { error: 'Failed to save. Please try again.', ok: false };
  }

  return { ok: true };
}
