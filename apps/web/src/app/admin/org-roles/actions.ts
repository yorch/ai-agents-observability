'use server';

import { AuditAction, OrgRole } from '@ai-agents-observability/db';
import { revalidatePath } from 'next/cache';

import { writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const ASSIGNABLE: ReadonlySet<OrgRole> = new Set<OrgRole>([
  OrgRole.member,
  OrgRole.viewer_aggregate,
  OrgRole.investigator,
  OrgRole.org_admin,
]);

/**
 * Org-admin action: set a user's org role (P9-005). Granting `investigator` gives
 * aggregate access + the ability to request time-boxed grants — never standing
 * individual access. Audited via `role_grant`.
 */
export async function setOrgRole(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();

  const targetUserId = String(formData.get('userId') ?? '');
  const role = String(formData.get('role') ?? '') as OrgRole;
  if (!targetUserId || !ASSIGNABLE.has(role)) {
    return;
  }
  // Guard against an admin removing their own admin access by accident.
  if (targetUserId === user.id && role !== OrgRole.org_admin) {
    return;
  }

  const { count } = await getPrisma().user.updateMany({
    data: { orgRole: role },
    where: { id: targetUserId },
  });

  if (count > 0) {
    await writeAuditLog({
      action: AuditAction.role_grant,
      actorUserId: user.id,
      justification: `Set org role to ${role}`,
      targetUserId,
    });
  }

  revalidatePath('/admin/org-roles');
}
