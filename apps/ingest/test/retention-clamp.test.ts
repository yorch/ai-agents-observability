import { describe, expect, it } from 'vitest';

import { effectiveRetentionDays } from '../src/jobs/retention-policy.ts';

describe('effectiveRetentionDays (P9-004)', () => {
  it('uses the global default when a team has no override (unchanged behavior)', () => {
    expect(effectiveRetentionDays(null, 365, 730)).toBe(365);
  });

  it('uses a shorter team override as-is', () => {
    expect(effectiveRetentionDays(30, 365, 730)).toBe(30);
  });

  it('uses a longer team override up to the org max', () => {
    expect(effectiveRetentionDays(500, 365, 730)).toBe(500);
  });

  it('clamps an override above the org max (never rejects)', () => {
    expect(effectiveRetentionDays(800, 365, 730)).toBe(730);
  });

  it('clamps the global default too when it exceeds the org max', () => {
    expect(effectiveRetentionDays(null, 1000, 730)).toBe(730);
  });
});
