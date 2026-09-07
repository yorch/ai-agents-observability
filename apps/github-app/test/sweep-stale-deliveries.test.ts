import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { sweepStaleDeliveries } from '../src/jobs/sweep-stale-deliveries';
import type { AppDb } from '../src/types';

/**
 * The sweep reports deliveries accepted from GitHub and then never finished.
 *
 * The assertions worth reading are the two about the WHERE clause. This job's
 * value is entirely in counting the right rows: count too many (by ignoring the
 * grace period, or by including `processed`) and the gauge is permanently
 * non-zero on a busy install, which trains everyone to ignore the one alert that
 * says telemetry is being dropped.
 */

const logger = pino({ level: 'silent' });

type CountArgs = { where: { receivedAt: { lt: Date }; status: string } };

/** A db whose `count` records the predicate it was given. */
function dbSpy(result: number) {
  const seen: CountArgs[] = [];
  const db = {
    webhookDelivery: {
      count: async (args: CountArgs) => {
        seen.push(args);
        return result;
      },
      findFirst: async () => ({
        deliveryId: 'delivery-oldest',
        eventType: 'pull_request',
        receivedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    },
  } as unknown as AppDb;
  return { db, seen };
}

describe('sweepStaleDeliveries', () => {
  it('counts only rows still marked received', async () => {
    // A `processed` or `error` row reached a terminal state and is not a loss.
    const { db, seen } = dbSpy(3);

    await sweepStaleDeliveries(db, logger);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.where.status).toBe('received');
  });

  it('excludes deliveries young enough to still be processing', async () => {
    // The grace period. A delivery being handled RIGHT NOW is legitimately
    // `received` — handlers make GitHub API calls and several DB writes. Without
    // a cutoff every in-flight delivery counts as lost.
    const { db, seen } = dbSpy(0);

    const before = Date.now();
    await sweepStaleDeliveries(db, logger);
    const cutoff = seen[0]?.where.receivedAt.lt as Date;

    expect(cutoff.getTime()).toBeLessThanOrEqual(before);
    // Comfortably longer than any handler, comfortably shorter than the 30-day
    // retention window, so a stuck delivery still surfaces the same day.
    const graceMs = before - cutoff.getTime();
    expect(graceMs).toBeGreaterThanOrEqual(10 * 60 * 1_000);
    expect(graceMs).toBeLessThan(24 * 60 * 60 * 1_000);
  });

  it('returns the count so it can be asserted and gauged', async () => {
    const { db } = dbSpy(7);
    expect(await sweepStaleDeliveries(db, logger)).toBe(7);
  });

  it('reports zero without querying for an oldest row', async () => {
    // Positive control on the happy path: a healthy install must not pay for a
    // second query every hour, and must not log a warning.
    let findFirstCalls = 0;
    const db = {
      webhookDelivery: {
        count: async () => 0,
        findFirst: async () => {
          findFirstCalls += 1;
          return null;
        },
      },
    } as unknown as AppDb;

    expect(await sweepStaleDeliveries(db, logger)).toBe(0);
    expect(findFirstCalls).toBe(0);
  });

  it('never throws when the database is unavailable', async () => {
    // It shares a timer with the retention prune; a reporting job must not be
    // able to take the service down.
    const db = {
      webhookDelivery: {
        count: async () => {
          throw new Error('connection refused');
        },
      },
    } as unknown as AppDb;

    await expect(sweepStaleDeliveries(db, logger)).resolves.toBe(0);
  });
});
