import { describe, expect, it } from 'vitest';
import { grantCovers, isGrantActive } from '../src/lib/grant-policy.js';

const NOW = new Date('2026-06-24T12:00:00Z');
const future = new Date('2026-06-25T12:00:00Z');
const past = new Date('2026-06-23T12:00:00Z');

describe('isGrantActive', () => {
  it('is active when approved, not revoked, not expired', () => {
    expect(isGrantActive({ expiresAt: future, grantedAt: past, revokedAt: null }, NOW)).toBe(true);
  });

  it('is inactive when not yet approved', () => {
    expect(isGrantActive({ expiresAt: future, grantedAt: null, revokedAt: null }, NOW)).toBe(false);
  });

  it('is inactive when revoked', () => {
    expect(isGrantActive({ expiresAt: future, grantedAt: past, revokedAt: past }, NOW)).toBe(false);
  });

  it('is inactive when expired (treated like no grant)', () => {
    expect(isGrantActive({ expiresAt: past, grantedAt: past, revokedAt: null }, NOW)).toBe(false);
  });
});

describe('grantCovers', () => {
  it('single_session matches only the exact session', () => {
    const g = { scope: 'single_session' as const, targetSessionId: 's1', targetUserId: null };
    expect(grantCovers(g, { targetSessionId: 's1' })).toBe(true);
    expect(grantCovers(g, { targetSessionId: 's2' })).toBe(false);
    expect(grantCovers(g, { targetUserId: 'u1' })).toBe(false);
  });

  it('user_sessions matches any session of the target user', () => {
    const g = { scope: 'user_sessions' as const, targetSessionId: null, targetUserId: 'u1' };
    expect(grantCovers(g, { targetSessionId: 'sX', targetUserId: 'u1' })).toBe(true);
    expect(grantCovers(g, { targetUserId: 'u2' })).toBe(false);
  });
});
