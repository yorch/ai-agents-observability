'use server';

import { AuditAction } from '@ai-agents-observability/db';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

/**
 * Org-admin action: set or clear a team's transcript-retention override (P9-004).
 * Empty input clears the override (team reverts to the global default). The change
 * is audited via `retention_override_changed`. Clamping to the org maximum happens
 * in the sweep job, not here — the stored value is the admin's literal intent.
 */
export async function setTeamRetention(formData: FormData): Promise<ActionResult> {
  const { user } = await requireOrgAdmin();

  const teamId = String(formData.get('teamId') ?? '');
  const raw = String(formData.get('retentionDays') ?? '').trim();
  if (!teamId) {
    return { error: 'Missing team.', ok: false };
  }

  let retentionDays: number | null = null;
  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'Retention must be a whole number of days (1 or more).', ok: false };
    }
    retentionDays = n;
  }

  const db = getPrisma();
  const { count } = await db.team.updateMany({ data: { retentionDays }, where: { id: teamId } });

  if (count === 0) {
    return { error: 'Team not found — refresh and try again.', ok: false };
  }

  await writeAuditLog({
    action: AuditAction.RETENTION_OVERRIDE_CHANGED,
    actorUserId: user.id,
    justification:
      retentionDays === null
        ? 'Cleared retention override (revert to global default)'
        : `Set retention override to ${retentionDays} days`,
    targetTeamId: teamId,
  });

  revalidatePath('/admin/retention');
  return {
    message:
      retentionDays === null ? 'Override cleared.' : `Retention set to ${retentionDays} days.`,
    ok: true,
  };
}
