'use server';

import { AuditAction, GrantScope } from '@ai-agents-observability/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';
import { getSession } from '@/lib/sessions-queries';

const ALLOWED_DAYS = [1, 7, 30];
const DEFAULT_DAYS = 7;

export type ShareResult = { error: string } | { email: string; ok: true; sessionId: string };

export async function shareSession(formData: FormData): Promise<ShareResult> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const sessionId = String(formData.get('sessionId') ?? '').trim();
  const targetEmail = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const daysRaw = Number(formData.get('days') ?? DEFAULT_DAYS);
  const days = ALLOWED_DAYS.includes(daysRaw) ? daysRaw : DEFAULT_DAYS;

  if (!sessionId || !targetEmail) {
    return { error: 'Session ID and email are required.' };
  }

  const db = getPrisma();

  // Verify the session belongs to the calling user.
  const session = await getSession(user.id, sessionId);
  if (!session) {
    return { error: 'Session not found.' };
  }

  const target = await db.user.findFirst({
    select: { id: true },
    where: { email: targetEmail },
  });
  if (!target) {
    return { error: `No account found for ${targetEmail}.` };
  }
  if (target.id === user.id) {
    return { error: 'You cannot share a session with yourself.' };
  }

  // Check if already shared with this user.
  const existing = await db.accessGrant.findFirst({
    where: {
      expiresAt: { gt: new Date() },
      grantedAt: { not: null },
      granteeUserId: target.id,
      revokedAt: null,
      targetSessionId: sessionId,
    },
  });
  if (existing) {
    return { error: `Already shared with ${targetEmail}.` };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 86_400_000);

  // Auto-approve: owner consent means immediate access, no pending state.
  await db.accessGrant.create({
    data: {
      expiresAt,
      grantedAt: now,
      grantedByUserId: user.id,
      granteeUserId: target.id,
      justification: `Session owner shared directly (${days}d)`,
      scope: GrantScope.SINGLE_SESSION,
      targetSessionId: sessionId,
    },
  });

  void writeAuditLog({
    action: AuditAction.GRANT_APPROVED,
    actorUserId: user.id,
    justification: `Owner shared session with ${targetEmail} for ${days} day(s)`,
    targetSessionId: sessionId,
    targetUserId: target.id,
  });

  revalidatePath(`/me/sessions/${sessionId}`);
  return { email: targetEmail, ok: true, sessionId };
}

/**
 * R11: the session owner records a lightweight quality signal on their own
 * session (thumbs up/down + optional note). Upserted per (session, user); an
 * empty sentiment clears it. Own-session only — verified via getSession.
 */
export async function submitSessionFeedback(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const sessionId = String(formData.get('sessionId') ?? '').trim();
  const sentiment = String(formData.get('sentiment') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  if (!sessionId) {
    return;
  }

  // Own-session only.
  const session = await getSession(user.id, sessionId);
  if (!session) {
    return;
  }

  const db = getPrisma();

  if (sentiment !== 'up' && sentiment !== 'down') {
    // Clearing feedback.
    await db.sessionFeedback.deleteMany({ where: { sessionId, userId: user.id } });
    revalidatePath(`/me/sessions/${sessionId}`);
    return;
  }

  const trimmedNote = note.slice(0, 1000) || null;
  await db.sessionFeedback.upsert({
    create: { note: trimmedNote, sentiment, sessionId, userId: user.id },
    update: { note: trimmedNote, sentiment, updatedAt: new Date() },
    where: { sessionId_userId: { sessionId, userId: user.id } },
  });

  revalidatePath(`/me/sessions/${sessionId}`);
}

/** Lets the session owner revoke any active share on their own session. */
export async function revokeShare(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const grantId = String(formData.get('grantId') ?? '').trim();
  const sessionId = String(formData.get('sessionId') ?? '').trim();
  if (!grantId || !sessionId) {
    return;
  }

  // Verify the session belongs to the calling user.
  const session = await getSession(user.id, sessionId);
  if (!session) {
    return;
  }

  const db = getPrisma();
  const grant = await db.accessGrant.findFirst({
    where: { id: grantId, revokedAt: null, targetSessionId: sessionId },
  });
  if (!grant) {
    return;
  }

  const { count } = await db.accessGrant.updateMany({
    data: { revokedAt: new Date() },
    where: { id: grantId, revokedAt: null },
  });

  if (count > 0) {
    void writeAuditLog({
      action: AuditAction.GRANT_REVOKED,
      actorUserId: user.id,
      targetSessionId: sessionId,
      targetUserId: grant.granteeUserId,
    });
  }

  revalidatePath(`/me/sessions/${sessionId}`);
}
