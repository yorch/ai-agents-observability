'use server';

import { AuditAction, OrgRole } from '@ai-agents-observability/db';
import { revalidatePath } from 'next/cache';

import { withActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const ASSIGNABLE: ReadonlySet<OrgRole> = new Set<OrgRole>([
  OrgRole.MEMBER,
  OrgRole.VIEWER_AGGREGATE,
  OrgRole.INVESTIGATOR,
  OrgRole.ORG_ADMIN,
]);

/**
 * Org-admin action: set a user's org role (P9-005). Granting `investigator` gives
 * aggregate access + the ability to request time-boxed grants — never standing
 * individual access. Audited via `role_grant`.
 */
export const setOrgRole = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();

  const targetUserId = String(formData.get('userId') ?? '');
  const role = String(formData.get('role') ?? '') as OrgRole;
  if (!targetUserId || !ASSIGNABLE.has(role)) {
    return { error: 'Choose a valid role.', ok: false };
  }
  // Guard against an admin removing their own admin access by accident.
  if (targetUserId === user.id && role !== OrgRole.ORG_ADMIN) {
    return { error: "You can't remove your own admin role — ask another admin.", ok: false };
  }

  const { count } = await getPrisma().user.updateMany({
    data: { orgRole: role },
    where: { id: targetUserId },
  });

  if (count === 0) {
    return { error: 'User not found — refresh and try again.', ok: false };
  }

  await writeAuditLog({
    action: AuditAction.ROLE_GRANT,
    actorUserId: user.id,
    justification: `Set org role to ${role}`,
    targetUserId,
  });

  revalidatePath('/admin/org-roles');
  return { message: 'Role updated.', ok: true };
});
