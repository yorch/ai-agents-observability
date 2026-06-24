import { describe, expect, it } from 'vitest';

import { grantCovers, isGrantActive } from '../src/lib/grant-policy.js';

// Consolidated Phase 9 governance invariants (P9-006). Uses the Prisma-free grant
// policy so it runs in CI without a database. The investigator role capability
// invariants (canViewIndividuals=false, canRequestGrants=true) live in
// roles.test.ts (added in P9-005).

const NOW = new Date('2026-06-24T12:00:00Z');

describe('grant expiry invariant (P9-003)', () => {
  it('is active ONLY when approved, not revoked, and not yet expired', () => {
    // Property-style: sweep expiry deltas (minutes) x revoked x approved.
    for (const deltaMin of [-1440, -1, 0, 1, 1440]) {
      for (const revoked of [null, new Date(NOW.getTime() - 1000)]) {
        for (const granted of [null, new Date(NOW.getTime() - 100000)]) {
          const expiresAt = new Date(NOW.getTime() + deltaMin * 60_000);
          const active = isGrantActive({ expiresAt, grantedAt: granted, revokedAt: revoked }, NOW);
          const expected = granted !== null && revoked === null && expiresAt > NOW;
          expect(active).toBe(expected);
        }
      }
    }
  });

  it('an expired grant is indistinguishable from no grant (both deny)', () => {
    const expired = {
      expiresAt: new Date(NOW.getTime() - 60_000),
      grantedAt: NOW,
      revokedAt: null,
    };
    expect(isGrantActive(expired, NOW)).toBe(false);
  });
});

describe('no-grant denial invariant (P9-003 / P9-005)', () => {
  it('an empty active-grant set never permits access (≥5 targets)', () => {
    const activeGrants: { scope: 'USER_SESSIONS'; targetSessionId: null; targetUserId: string }[] =
      [];
    for (const t of ['s1', 's2', 's3', 's4', 's5']) {
      const permitted = activeGrants.some((g) =>
        grantCovers(g, { targetSessionId: t, targetUserId: 'u1' }),
      );
      expect(permitted).toBe(false);
    }
  });

  it('a grant for one target never covers a different target', () => {
    const single = {
      scope: 'SINGLE_SESSION' as const,
      targetSessionId: 's-allowed',
      targetUserId: null,
    };
    for (const other of ['s-other-1', 's-other-2', 's-other-3', 's-other-4', 's-other-5']) {
      expect(grantCovers(single, { targetSessionId: other })).toBe(false);
    }
    expect(grantCovers(single, { targetSessionId: 's-allowed' })).toBe(true);

    const userScoped = {
      scope: 'USER_SESSIONS' as const,
      targetSessionId: null,
      targetUserId: 'u-allowed',
    };
    for (const other of ['u-1', 'u-2', 'u-3', 'u-4', 'u-5']) {
      expect(grantCovers(userScoped, { targetUserId: other })).toBe(false);
    }
    expect(grantCovers(userScoped, { targetUserId: 'u-allowed' })).toBe(true);
  });
});
