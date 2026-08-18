'use server';

import { AuditAction, computePRRollup, GrantScope } from '@ai-agents-observability/db';
import {
  capturedRubricVersion,
  parseRubricOutcome,
  parseRubricShape,
} from '@ai-agents-observability/schemas';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { withActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';
import { deleteScore, upsertScore } from '@/lib/scores';
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
 * R11 + P13-005: the session owner records their own judgement of their own
 * session — a thumbs, an optional note, and the two versioned rubric answers
 * (which shape, and did it accomplish what you wanted).
 *
 * Own-session only, verified via `getSession`. There is deliberately **no** path
 * here for labelling anyone else's session: owner self-labelling is the only
 * label source that is both cheap and trust-preserving, and a researcher-grant
 * variant would need its own trust review (P13-005 "out of scope").
 *
 * The rubric answers are written as `scores` rows with `source: HUMAN` and the
 * rubric version as `scorer_version`, so the calibration work in P13-007 reads
 * one table instead of joining a bespoke one. Nothing aggregates or exposes
 * these beyond this page — capture only.
 *
 * **`scores` is the only home for an answer.** The two columns that briefly
 * mirrored them onto `session_feedback` are gone (migration
 * `20260813100000_drop_session_feedback_rubric_answers`): one fact written to
 * two stores in two separate awaits diverges the first time a request fails
 * between them, and it would be P13-007's copy — the one everything downstream
 * reads — that lost. What remains on the feedback row is what no score row can
 * express: the thumbs, the note, and `rubric_version`, which distinguishes
 * "answered v1 and declined both questions" from "predates the rubric".
 *
 * The feedback row and the score rows still move together, so they are written
 * in **one `$transaction`**: a half-applied submission would leave the rubric
 * version claiming an answer that no score row holds.
 */
export const submitSessionFeedback = withActionResult(async (formData) => {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const sessionId = String(formData.get('sessionId') ?? '').trim();
  const sentimentRaw = String(formData.get('sentiment') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  // Anything that is not a current-rubric option parses to null — an unanswered
  // question and a stale option from an older rubric are both "no label".
  const shape = parseRubricShape(String(formData.get('rubricShape') ?? ''));
  const taskOutcome = parseRubricOutcome(String(formData.get('rubricOutcome') ?? ''));
  if (!sessionId) {
    return { error: 'Session not found.', ok: false };
  }

  // Own-session only.
  const session = await getSession(user.id, sessionId);
  if (!session) {
    return { error: 'Session not found.', ok: false };
  }

  const db = getPrisma();
  const sentiment = sentimentRaw === 'up' || sentimentRaw === 'down' ? sentimentRaw : null;
  const trimmedNote = note.slice(0, 1000) || null;

  // The row is cleared only when the developer has retracted *everything*.
  // Sentiment alone no longer gates the row: a rubric answer with no thumbs is a
  // legitimate label, and deleting it because the thumbs was toggled off would
  // silently discard the more informative half.
  if (sentiment === null && trimmedNote === null && shape === null && taskOutcome === null) {
    // A retraction is the same two stores in the other direction, so it takes
    // the same transaction: a label surviving the feedback row it was given
    // alongside is the retraction not happening.
    await db.$transaction(async (tx) => {
      await tx.sessionFeedback.deleteMany({ where: { sessionId, userId: user.id } });
      await deleteScore('human_session_shape', sessionId, tx);
      await deleteScore('human_task_outcome', sessionId, tx);
    });
    revalidatePath(`/me/sessions/${sessionId}`);
    return { ok: true };
  }

  // The row records which rubric it answered even when both questions were
  // skipped: "declined to answer v1" and "predates the rubric" are different
  // facts, and only the first says anything about the rubric.
  const rubricVersion = capturedRubricVersion();
  await db.$transaction(async (tx) => {
    await tx.sessionFeedback.upsert({
      create: {
        note: trimmedNote,
        rubricVersion,
        sentiment,
        sessionId,
        userId: user.id,
      },
      update: {
        note: trimmedNote,
        rubricVersion,
        sentiment,
        updatedAt: new Date(),
      },
      where: { sessionId_userId: { sessionId, userId: user.id } },
    });

    // An unanswered question deletes rather than writes an empty row: "declined"
    // is carried by `rubric_version` on the row above, and an empty score row
    // would read as an answer.
    await (shape === null
      ? deleteScore('human_session_shape', sessionId, tx)
      : upsertScore({ label: shape, scorerName: 'human_session_shape', subjectId: sessionId }, tx));
    await (taskOutcome === null
      ? deleteScore('human_task_outcome', sessionId, tx)
      : upsertScore(
          { label: taskOutcome, scorerName: 'human_task_outcome', subjectId: sessionId },
          tx,
        ));
  });

  revalidatePath(`/me/sessions/${sessionId}`);
  return { ok: true };
});

export type PRLinkResult = { error: string } | { ok: true };

/**
 * Manually link this session to a PR in the session's repository — the escape
 * hatch for every case the automatic heuristics (PR-number at session start,
 * branch/SHA backfill at merge) miss. Own-session only; the PR must already be
 * tracked (webhooks populate pull_requests). Writes a MANUAL SessionPRLink and
 * recomputes the PR rollup so cost attribution updates immediately.
 */
export async function linkSessionPR(formData: FormData): Promise<PRLinkResult> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const sessionId = String(formData.get('sessionId') ?? '').trim();
  const prNumber = Number.parseInt(String(formData.get('prNumber') ?? ''), 10);
  if (!sessionId || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { error: 'A valid PR number is required.' };
  }

  const db = getPrisma();

  // Own-session only.
  const session = await db.session.findFirst({
    select: { repoId: true },
    where: { sessionId, userId: user.id },
  });
  if (!session) {
    return { error: 'Session not found.' };
  }
  if (!session.repoId) {
    return { error: 'This session has no repository context to link against.' };
  }
  const repoId = session.repoId;

  const pr = await db.pullRequest.findUnique({
    select: { prNumber: true },
    where: { repoId_prNumber: { prNumber, repoId } },
  });
  if (!pr) {
    return { error: `PR #${prNumber} is not tracked for this repository yet.` };
  }

  await db.sessionPRLink.upsert({
    create: { linkSource: 'MANUAL', prNumber, repoId, sessionId },
    update: {},
    where: { sessionId_repoId_prNumber: { prNumber, repoId, sessionId } },
  });
  await computePRRollup(db, repoId, prNumber);

  revalidatePath(`/me/sessions/${sessionId}`);
  return { ok: true };
}

/** Removes a MANUAL link (automatic links are owned by the pipeline). */
export async function unlinkSessionPR(formData: FormData): Promise<PRLinkResult> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const sessionId = String(formData.get('sessionId') ?? '').trim();
  const prNumber = Number.parseInt(String(formData.get('prNumber') ?? ''), 10);
  if (!sessionId || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { error: 'A valid PR number is required.' };
  }

  const db = getPrisma();

  const session = await db.session.findFirst({
    select: { repoId: true },
    where: { sessionId, userId: user.id },
  });
  if (!session?.repoId) {
    return { error: 'Session not found.' };
  }
  const repoId = session.repoId;

  const { count } = await db.sessionPRLink.deleteMany({
    where: { linkSource: 'MANUAL', prNumber, repoId, sessionId },
  });
  if (count === 0) {
    return { error: 'Only manually-added links can be removed.' };
  }
  await computePRRollup(db, repoId, prNumber);

  revalidatePath(`/me/sessions/${sessionId}`);
  return { ok: true };
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
