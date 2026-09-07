import type { Logger } from 'pino';

import { recordStaleDeliveries } from '../lib/metrics';
import type { AppDb } from '../types';

/**
 * Report webhook deliveries that were accepted and then never finished.
 *
 * WHAT THIS IS FOR
 *
 * `POST /webhooks/github` writes a `received` row, acks 202, and only then
 * processes — detached. GitHub retries non-2xx only, so once we have acked it
 * will never redeliver. If the process dies between the row and handler
 * completion, that event is gone: nothing reprocesses it, and the only trace is
 * a row that still says `received` until the 30-day retention prune deletes it.
 *
 * The early ack is deliberate — it stops a handler failure from making GitHub
 * resend and post a duplicate PR comment — so the loss is a chosen trade, not a
 * bug. What was missing is that nobody could SEE it. This makes the population
 * countable and alertable.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not reprocess, and it does not delete. Reprocessing would mean
 * asserting that every handler is idempotent — `postPRComment` scans for its own
 * marker, but `computePRRollup`, `backfillPRLinks` and `handleCheckRun` would
 * each need checking, and being wrong there means duplicate bot comments on
 * someone's PR. Deleting is retention's job. Report only.
 *
 * WHY THE GRACE PERIOD IS NOT OPTIONAL
 *
 * A delivery being processed right now is legitimately `received`. Handlers make
 * GitHub API calls (`listPRCommitShas`) and several DB writes, so they are not
 * instant. Counting those would make the gauge permanently non-zero on a busy
 * install and train everyone to ignore it — the failure mode of most alerts.
 * Fifteen minutes is far longer than any handler should take and far shorter
 * than the retention window, so a genuinely stuck delivery still surfaces the
 * same day.
 */

/** How long a delivery may legitimately sit in `received` before it counts. */
const STALE_AFTER_MS = 15 * 60 * 1_000;

/** How often to sweep. Hourly: this is a standing population, not an event. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export async function sweepStaleDeliveries(
  db: AppDb,
  logger: Logger,
  staleAfterMs: number = STALE_AFTER_MS,
): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stale = await db.webhookDelivery.count({
      where: { receivedAt: { lt: cutoff }, status: 'received' },
    });

    recordStaleDeliveries(stale);

    if (stale > 0) {
      // Name the oldest one: a single ancient row and a rising count are
      // different problems, and the id is what makes a delivery findable in
      // GitHub's own webhook log, where the payload can still be re-sent by hand.
      const oldest = await db.webhookDelivery.findFirst({
        orderBy: { receivedAt: 'asc' },
        select: { deliveryId: true, eventType: true, receivedAt: true },
        where: { receivedAt: { lt: cutoff }, status: 'received' },
      });
      logger.warn(
        {
          oldest_delivery: oldest?.deliveryId,
          oldest_event: oldest?.eventType,
          oldest_received_at: oldest?.receivedAt,
          stale,
        },
        'webhook.delivery.stale',
      );
    }

    return stale;
  } catch (err) {
    // Never throw: this runs on a timer beside the retention prune, and a
    // reporting job must not take the service down.
    logger.warn({ err }, 'webhook.delivery.stale_sweep_error');
    return 0;
  }
}
