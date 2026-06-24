'use server';

import { AuditAction, type TeamRole } from '@ai-agents-observability/db';
import { revalidatePath } from 'next/cache';

import { writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const ASSIGNABLE: ReadonlySet<TeamRole> = new Set<TeamRole>(['member', 'lead']);

/**
 * Org-admin action: explicitly set a team member's role (member ↔ lead). This is
 * the deliberate grant model chosen over auto-mapping GitHub team-maintainer —
 * dashboard team-lead visibility is granted, never inferred. Every change is
 * audited (`role_grant`).
 */
export async function setTeamRole(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();

  const teamId = String(formData.get('teamId') ?? '');
  const userId = String(formData.get('userId') ?? '');
  const role = String(formData.get('role') ?? '') as TeamRole;

  if (!teamId || !userId || !ASSIGNABLE.has(role)) {
    return;
  }

  const db = getPrisma();
  // updateMany (not update) so a row removed between page render and submit, or a
  // tampered (teamId,userId), is a no-op rather than a thrown P2025 that would
  // surface as an error with no audit trail.
  const { count } = await db.teamMember.updateMany({
    data: { roleInTeam: role },
    where: { teamId, userId },
  });

  if (count > 0) {
    await writeAuditLog({
      action: AuditAction.role_grant,
      actorUserId: user.id,
      justification: `Set team role to ${role}`,
      targetTeamId: teamId,
      targetUserId: userId,
    });
  }

  revalidatePath('/admin/team-roles');
}
