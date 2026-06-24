// Pure access-grant predicates (P9-003), kept free of any Prisma runtime import so
// they are unit-testable without the generated client. The DB query in roles.ts
// (hasActiveGrant) handles the "active" window; these decide scope coverage and
// document the activeness rule.

export type GrantScope = 'user_sessions' | 'single_session';

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

/**
 * Whether a grant's scope covers the requested target. A `single_session` grant
 * matches only its exact session; a `user_sessions` grant matches any session of
 * its target user (callers pass the session's owner as targetUserId).
 */
export function grantCovers(
  grant: { scope: GrantScope; targetSessionId: string | null; targetUserId: string | null },
  target: GrantTarget,
): boolean {
  if (grant.scope === 'single_session') {
    return grant.targetSessionId != null && grant.targetSessionId === target.targetSessionId;
  }
  return grant.targetUserId != null && grant.targetUserId === target.targetUserId;
}
