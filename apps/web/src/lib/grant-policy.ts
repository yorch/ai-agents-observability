// Pure access-grant predicates (P9-003), kept free of any Prisma runtime import so
// they are unit-testable without the generated client. The DB query in roles.ts
// (hasActiveGrant) handles the "active" window; these decide scope coverage and
// document the activeness rule.

export type GrantScope = 'USER_SESSIONS' | 'SINGLE_SESSION';

export type GrantTarget = { targetSessionId?: string; targetUserId?: string };

/**
 * A grant is active only when it has been approved (granted_at set), not revoked,
 * and not yet expired. An expired grant is indistinguishable from no grant.
 */
export function isGrantActive(
  grant: { expiresAt: Date | null; grantedAt: Date | null; revokedAt: Date | null },
  now: Date,
): boolean {
  return (
    grant.grantedAt !== null &&
    grant.revokedAt === null &&
    grant.expiresAt !== null &&
    grant.expiresAt > now
  );
}

// An active grant within this window of its expiry is surfaced as "expiring soon"
// (R8) — to the holder (/me/grants) and the approving admin (/admin/access-grants).
export const GRANT_EXPIRING_SOON_MS = 6 * 3_600_000;

/**
 * Whether an active grant is within GRANT_EXPIRING_SOON_MS of lapsing. Callers
 * gate on the grant being active first; this only checks the time window (null
 * expiry → not expiring).
 */
export function isGrantExpiringSoon(expiresAt: Date | null, now: Date = new Date()): boolean {
  return expiresAt !== null && expiresAt.getTime() - now.getTime() < GRANT_EXPIRING_SOON_MS;
}

/**
 * Whether a grant's scope covers the requested target. A `single_session` grant
 * matches only its exact session; a `user_sessions` grant matches any session of
 * its target user (callers pass the session's owner as targetUserId).
 */
export function grantCovers(
  grant: { scope: GrantScope; targetSessionId: string | null; targetUserId: string | null },
  target: GrantTarget,
): boolean {
  if (grant.scope === 'SINGLE_SESSION') {
    return grant.targetSessionId != null && grant.targetSessionId === target.targetSessionId;
  }
  return grant.targetUserId != null && grant.targetUserId === target.targetUserId;
}
