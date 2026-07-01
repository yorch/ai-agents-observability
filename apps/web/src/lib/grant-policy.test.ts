import { describe, expect, it } from 'vitest';

import { GRANT_EXPIRING_SOON_MS, isGrantExpiringSoon } from './grant-policy';

describe('isGrantExpiringSoon', () => {
  const now = new Date('2026-06-30T12:00:00Z');

  it('is true within the window of expiry', () => {
    const soon = new Date(now.getTime() + GRANT_EXPIRING_SOON_MS - 60_000);
    expect(isGrantExpiringSoon(soon, now)).toBe(true);
  });

  it('is false when expiry is further out than the window', () => {
    const later = new Date(now.getTime() + GRANT_EXPIRING_SOON_MS + 60_000);
    expect(isGrantExpiringSoon(later, now)).toBe(false);
  });

  it('is false for a null expiry', () => {
    expect(isGrantExpiringSoon(null, now)).toBe(false);
  });

  it('is true for an already-past expiry (callers gate on active separately)', () => {
    const past = new Date(now.getTime() - 60_000);
    expect(isGrantExpiringSoon(past, now)).toBe(true);
  });
});
