'use server';

import { AuditAction, type GrantScope } from '@ai-agents-observability/db';
import { revalidatePath } from 'next/cache';

import { writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireGrantRequester, requireOrgAdmin } from '@/lib/roles';

// Default grant lifetime when an approver doesn't specify one (P9-003).
const DEFAULT_GRANT_HOURS = 48;

/**
 * Request a time-boxed transcript-access grant (DESIGN_DOC §8.4). For now only
 * org_admins can request (P9-005 adds the research capability). The grant starts
 * UNAPPROVED (granted_at null) — it grants nothing until an org_admin approves.
 */
export async function requestGrant(formData: FormData): Promise<void> {
  // org_admin OR investigator (P9-005) — never viewer_aggregate. Approval still
  // requires org_admin, so an investigator can't self-approve.
  const { user } = await requireGrantRequester();

  const scope = String(formData.get('scope') ?? '') as GrantScope;
  const justification = String(formData.get('justification') ?? '').trim();
  const targetUserId = String(formData.get('targetUserId') ?? '').trim() || null;
  const targetSessionId = String(formData.get('targetSessionId') ?? '').trim() || null;

  if (justification.length < 3) {
    return;
  }
  if (scope === 'SINGLE_SESSION' && !targetSessionId) {
    return;
  }
  if (scope === 'USER_SESSIONS' && !targetUserId) {
    return;
  }

  const grant = await getPrisma().accessGrant.create({
    data: { granteeUserId: user.id, justification, scope, targetSessionId, targetUserId },
  });

  await writeAuditLog({
    action: AuditAction.GRANT_REQUESTED,
    actorUserId: user.id,
    justification,
    targetSessionId: targetSessionId ?? undefined,
    targetUserId: targetUserId ?? undefined,
  });

  revalidatePath('/admin/access-grants');
  void grant;
}

/**
 * Approve a pending grant: set granted_at + a required expiry (default 48h). Only
 * org_admins approve. Audited; the viewed user sees it in /me/audit.
 */
export async function approveGrant(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();

  const id = String(formData.get('id') ?? '');
  const hoursRaw = String(formData.get('hours') ?? '').trim();
  const hours = Number(hoursRaw) > 0 ? Number(hoursRaw) : DEFAULT_GRANT_HOURS;
  if (!id) {
    return;
  }

  const db = getPrisma();
  const expiresAt = new Date(Date.now() + hours * 3_600_000);

  // Read the grant's targets BEFORE the update so the audit row always has full
  // context — a refetch after the write could race a concurrent grant deletion.
  const grant = await db.accessGrant.findFirst({ where: { grantedAt: null, id, revokedAt: null } });
  if (!grant) {
    return;
  }

  // updateMany so a grant approved/revoked between the read and write is a no-op,
  // not a thrown P2025. Only approve grants that are still pending.
  const { count } = await db.accessGrant.updateMany({
    data: { expiresAt, grantedAt: new Date(), grantedByUserId: user.id },
    where: { grantedAt: null, id, revokedAt: null },
  });

  if (count > 0) {
    await writeAuditLog({
      action: AuditAction.GRANT_APPROVED,
      actorUserId: user.id,
      justification: `Approved grant, expires ${expiresAt.toISOString()}`,
      targetSessionId: grant.targetSessionId ?? undefined,
      targetUserId: grant.targetUserId ?? undefined,
    });
  }

  revalidatePath('/admin/access-grants');
}

/**
 * R8: approve every currently-pending grant in one action (bulk approve from the
 * "needs attention" queue), each with the same bounded window. Writes one audit
 * row per grant so each viewed user still sees the access in their feed.
 */
export async function approveAllPending(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();
  const hoursRaw = String(formData.get('hours') ?? '').trim();
  const hours = Number(hoursRaw) > 0 ? Number(hoursRaw) : DEFAULT_GRANT_HOURS;

  const db = getPrisma();
  const pending = await db.accessGrant.findMany({ where: { grantedAt: null, revokedAt: null } });
  if (pending.length === 0) {
    return;
  }

  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  await db.accessGrant.updateMany({
    data: { expiresAt, grantedAt: new Date(), grantedByUserId: user.id },
    where: { grantedAt: null, revokedAt: null },
  });

  for (const g of pending) {
    await writeAuditLog({
      action: AuditAction.GRANT_APPROVED,
      actorUserId: user.id,
      justification: `Bulk-approved, expires ${expiresAt.toISOString()}`,
      targetSessionId: g.targetSessionId ?? undefined,
      targetUserId: g.targetUserId ?? undefined,
    });
  }

  revalidatePath('/admin/access-grants');
}

/** Revoke an active grant immediately (sets revoked_at). Audited. */
export async function revokeGrant(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();

  const id = String(formData.get('id') ?? '');
  if (!id) {
    return;
  }

  const db = getPrisma();
  const grant = await db.accessGrant.findFirst({ where: { id, revokedAt: null } });
  if (!grant) {
    return;
  }

  const { count } = await db.accessGrant.updateMany({
    data: { revokedAt: new Date() },
    where: { id, revokedAt: null },
  });

  if (count > 0) {
    await writeAuditLog({
      action: AuditAction.GRANT_REVOKED,
      actorUserId: user.id,
      targetSessionId: grant.targetSessionId ?? undefined,
      targetUserId: grant.targetUserId ?? undefined,
    });
  }

  revalidatePath('/admin/access-grants');
}
