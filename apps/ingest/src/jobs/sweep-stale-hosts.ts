import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

import { withJobRun } from './job-run';

type StaleHostRow = {
  host_hash: string;
  latest_event: Date;
  session_count: bigint;
};

/**
 * Diagnostic sweep: logs a structured warning for each host that was active
 * recently (last event within 7 days) but has gone silent (no event in 24h).
 *
 * This is the server-side complement to the client-side heartbeat: it catches
 * stalled flushers that `aiot status` cannot, because the operator only sees
 * their own machine. A host that was sending events yesterday and stopped is
 * the signature of a daemon that loaded but is not making progress.
 *
 * The alert uses `host_hash` — a one-way hash, not raw machine identity — so
 * the warning identifies a distinct host without exposing it. Hosts with no
 * `host_hash` are invisible to this job by design.
 *
 * This job only logs; it does not modify any rows.
 */
export async function runSweepStaleHosts(db: PrismaClient, logger?: Logger): Promise<void> {
  await withJobRun(db, 'sweep-stale-hosts', logger, async () => {
    const rows = await db.$queryRaw<StaleHostRow[]>`
      -- run-kind-exempt: diagnostic sweep. Groups sessions by host_hash to
      -- detect stalled client daemons. A CI host that went silent is just as
      -- stuck as an interactive one; the alert is about the transport, not
      -- the person.
      SELECT host_hash, MAX(last_event_at) AS latest_event, COUNT(*) AS session_count
      FROM sessions
      WHERE host_hash IS NOT NULL
        AND last_event_at < NOW() - INTERVAL '24 hours'
        AND last_event_at > NOW() - INTERVAL '7 days'
      GROUP BY host_hash
      ORDER BY latest_event DESC
    `;

    for (const row of rows) {
      const ageHours = Math.floor((Date.now() - row.latest_event.getTime()) / 3_600_000);
      logger?.warn(
        {
          ageHours,
          host_hash: row.host_hash,
          session_count: Number(row.session_count),
        },
        'stale-host: host was active in the last 7 days but has not sent events in >24h',
      );
    }

    if (rows.length > 0) {
      logger?.info({ count: rows.length }, 'sweep-stale-hosts: found stale hosts');
    }
  });
}
