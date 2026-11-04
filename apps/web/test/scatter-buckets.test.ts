import { describe, expect, it } from 'vitest';

import {
  bucket,
  bucketStep,
  DURATION_LADDER_S,
  durationBucketStep,
  ladderStep,
  mapRows,
  niceStep,
} from '../src/lib/scatter-queries';

describe('scatter bucketing', () => {
  it('bucket is the lower edge and never floors a small value up to one step', () => {
    expect(bucket(0.01, 0.05)).toBe(0);
    expect(bucket(0.05, 0.05)).toBe(0.05);
    expect(bucket(0.09, 0.05)).toBe(0.05);
    expect(bucket(0.26, 0.05)).toBe(0.25);
    expect(bucket(299, 300)).toBe(0);
    expect(bucket(301, 300)).toBe(300);
  });

  it('niceStep snaps to 1/2/5 x 10^k', () => {
    expect(niceStep(0.037)).toBe(0.05);
    expect(niceStep(0.8)).toBe(1);
    expect(niceStep(1.4)).toBe(2);
    expect(niceStep(130)).toBe(200);
    expect(niceStep(0)).toBe(1);
  });

  it('bucketStep is data-derived and respects the floor', () => {
    const cheap = Array.from({ length: 100 }, (_, i) => i / 1000); // up to $0.10
    const dear = Array.from({ length: 100 }, (_, i) => i); // up to $100
    expect(bucketStep(cheap, 0.01)).toBeLessThan(bucketStep(dear, 0.01));
    expect(bucketStep([0, 0, 0], 0.01)).toBe(0.01);
    expect(bucketStep([], 60)).toBe(60);
  });

  it('duration step snaps to a human ladder and never goes below 5 minutes', () => {
    expect(ladderStep(1)).toBe(300);
    expect(ladderStep(301)).toBe(600);
    expect(ladderStep(1000)).toBe(1800);
    expect(ladderStep(10 ** 9)).toBe(86400);
    expect(durationBucketStep([10, 20, 30])).toBe(300);
    const long = Array.from({ length: 100 }, (_, i) => (i + 1) * 360); // up to 10h
    expect(DURATION_LADDER_S).toContain(durationBucketStep(long));
  });

  it('aggregate rows keep the coarse floors and do not fabricate a $0.05 floor', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      cost_usd: i % 2 === 0 ? 0.01 : 0.2,
      duration_seconds: 120 + i,
    }));
    const pts = mapRows(rows, true);
    expect(pts.some((p) => p.costUsd === 0.05)).toBe(false);
    expect(pts.every((p) => (p.costStepUsd ?? 0) >= 0.05)).toBe(true);
    expect(pts.every((p) => (p.durationStepSeconds ?? 0) >= 300)).toBe(true);
    expect(Math.min(...pts.map((p) => p.costUsd))).toBe(0);
    expect(pts.reduce((n, p) => n + p.sessionCount, 0) + (pts.suppressedSessions ?? 0)).toBe(60);
  });

  it('suppresses aggregate buckets with fewer than 3 sessions and reports the count', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => ({ cost_usd: 0.12, duration_seconds: 700 })),
      { cost_usd: 3.4, duration_seconds: 9000 },
      { cost_usd: 3.4, duration_seconds: 9100 },
      { cost_usd: 0.52, duration_seconds: 2000 },
    ];
    const pts = mapRows(rows, true);
    expect(pts.every((p) => p.sessionCount >= 3)).toBe(true);
    expect(pts.reduce((n, p) => n + p.sessionCount, 0)).toBe(4);
    expect(pts.suppressedSessions).toBe(3);
  });

  it('personal rows are passed through unbucketed and unsuppressed', () => {
    const pts = mapRows([{ cost_usd: '0.013', duration_seconds: 42 }], false);
    expect(pts).toEqual([{ costUsd: 0.013, durationSeconds: 42, sessionCount: 1 }]);
    expect(pts.suppressedSessions).toBeUndefined();
  });
});
