import type { PrismaClient } from '@ai-agents-observability/db';
import { AuditAction } from '@ai-agents-observability/db';
import { headers } from 'next/headers';

import { logger } from './logger';
import { getPrisma } from './prisma';
import { clientIp } from './request-meta';

export { AuditAction };

// §8.4 — an org admin may view a transcript the owner did NOT share with the org
// by supplying a written justification. Keep it long enough to be meaningful and
// short enough to store inline in the audit row.
export const MIN_JUSTIFICATION_LENGTH = 10;
export const MAX_JUSTIFICATION_LENGTH = 1000;

/**
 * Trims and validates a free-text justification. Returns the cleaned string when
 * it is within bounds, or `null` when it is absent / too short / too long — in
 * which case the caller must deny the privileged access.
 */
export function normalizeJustification(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_JUSTIFICATION_LENGTH || trimmed.length > MAX_JUSTIFICATION_LENGTH) {
    return null;
  }
  return trimmed;
}

export type AuditParams = {
  action: AuditAction;
  actorUserId: string;
  justification?: string | null;
  targetSessionId?: string | undefined;
  targetTeamId?: string | undefined;
  targetUserId?: string | undefined;
};

async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    return { ip: clientIp(h), userAgent: h.get('user-agent') };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/**
 * Writes a single audit log row for a privileged cross-user data access.
 * Never throws — errors are logged via the structured logger. Callers use `void`
 * for fire-and-forget.
 */
export async function writeAuditLog(
  params: AuditParams,
  db: Pick<PrismaClient, 'auditLog'> = getPrisma(),
): Promise<void> {
  const { ip, userAgent } = await requestMeta();
  try {
    await db.auditLog.create({
      data: {
        ...params,
        ip,
        justification: params.justification ?? null,
        targetSessionId: params.targetSessionId ?? null,
        targetTeamId: params.targetTeamId ?? null,
        targetUserId: params.targetUserId ?? null,
        userAgent,
      },
    });
  } catch (err) {
    logger.error(
      { action: params.action, actorUserId: params.actorUserId, err },
      'audit.write_failed',
    );
  }
}
