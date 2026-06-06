import type { PrismaClient } from '@ai-agents-observability/db';
import { AuditAction } from '@ai-agents-observability/db';
import { headers } from 'next/headers';

import { getPrisma } from './prisma';
import { clientIp } from './request-meta';

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
    return { ip: clientIp(h), userAgent: h.get('user-agent') };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/**
 * Writes a single audit log row for a privileged cross-user data access.
 * Never throws — errors are logged to stderr. Callers use `void` for fire-and-forget.
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
    console.error('[audit] failed to write audit log', err);
  }
}
