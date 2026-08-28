import { describe, expect, test } from 'vitest';
import { computeConcurrency } from '../src/lib/trend-queries';

const at = (hour: number, minute = 0) =>
  new Date(
    `2026-08-28T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
  );

describe('computeConcurrency', () => {
  test('counts peak overlap and parallel sessions without treating touching intervals as overlap', () => {
    const points = computeConcurrency(
      [
        { endedAt: at(11), startedAt: at(9) },
        { endedAt: at(12), startedAt: at(10) },
        { endedAt: at(13), startedAt: at(12) },
      ],
      at(9),
      new Date('2026-08-29T14:00:00.000Z'),
    );
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      parallelSessionCount: 2,
      parallelShare: 2 / 3,
      peakConcurrent: 2,
      sessionCount: 3,
    });
    expect(points[1]).toMatchObject({
      parallelSessionCount: 0,
      peakConcurrent: 0,
      sessionCount: 0,
    });
  });

  test('clips sessions crossing midnight to each UTC day', () => {
    const points = computeConcurrency(
      [
        {
          endedAt: new Date('2026-08-29T01:30:00.000Z'),
          startedAt: new Date('2026-08-28T23:30:00.000Z'),
        },
        {
          endedAt: new Date('2026-08-29T02:00:00.000Z'),
          startedAt: new Date('2026-08-29T00:30:00.000Z'),
        },
      ],
      new Date('2026-08-28T00:00:00.000Z'),
      new Date('2026-08-29T03:00:00.000Z'),
    );
    expect(points[0]).toMatchObject({ peakConcurrent: 1, sessionCount: 1 });
    expect(points[1]).toMatchObject({
      parallelSessionCount: 2,
      peakConcurrent: 2,
      sessionCount: 2,
    });
  });
});
