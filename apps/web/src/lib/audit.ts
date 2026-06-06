import type { PrismaClient } from '@ai-agents-observability/db';
import { AuditAction } from '@ai-agents-observability/db';
import { headers } from 'next/headers';

import { getPrisma } from './prisma';

export { AuditAction };

export type AuditParams = {
  action: AuditAction;
  actorUserId: string;
  justification?: string;
  targetSessionId?: string;
  targetTeamId?: string;
  targetUserId?: string;
};

async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    const forwarded = h.get('x-forwarded-for');
    const ip = forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
    const userAgent = h.get('user-agent');
    return { ip, userAgent };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/**
 * Writes a single audit log row for a privileged cross-user data access.
 * Fire-and-forget: awaited but never throws — errors are logged to stderr.
 */
export async function writeAuditLog(
  params: AuditParams,
  db: Pick<PrismaClient, 'auditLog'> = getPrisma(),
): Promise<void> {
  const { ip, userAgent } = await requestMeta();
  try {
    await db.auditLog.create({
      data: {
        action: params.action,
        actorUserId: params.actorUserId,
        ip,
        justification: params.justification ?? null,
        targetSessionId: params.targetSessionId ?? null,
        targetTeamId: params.targetTeamId ?? null,
        targetUserId: params.targetUserId ?? null,
        userAgent,
      },
    });
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}
