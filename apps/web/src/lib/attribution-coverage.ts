import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

/**
 * How much of a window's activity can actually be cost-attributed (P14-004).
 *
 * The two attribution columns are only populated for events that carry turn
 * linkage — `events.turn_number`, reported by the agent adapter. Sessions
 * ingested before an adapter reported it, and agents that do not report it at
 * all, produce no attribution: the columns stay NULL, and a `SUM()` over them
 * comes back NULL rather than 0.
 *
 * A page that rendered that as `$0.00` would be making exactly the mistake this
 * whole effort exists to fix — presenting a gap in capture as a measurement. So
 * every surface that shows attributed cost also shows this: what fraction of the
 * window's sessions have turn linkage at all. A dash next to "12% of sessions
 * have turn linkage" is a legible, honest answer; `$0.00` is not.
 *
 * Visibility is the caller's job, as everywhere else in the query layer: pass
 * the ids from `orgVisibleUserIds` / `resolveTeamVisibility`, or the single id of
 * the user reading their own page. This module never widens a population.
 */

export type AttributionCoverage = {
  /** Sessions in the window with at least one turn-linked event. */
  linkedSessions: number;
  /** 0–1, or null when the window holds no sessions at all. */
  ratio: number | null;
  /** Sessions in the window with any event at all. */
  totalSessions: number;
};

const EMPTY: AttributionCoverage = { linkedSessions: 0, ratio: null, totalSessions: 0 };

/**
 * Coverage across a set of users. Reads `interactive_events`, so CI and eval
 * runs are excluded from both halves of the fraction and the number means the
 * same thing as the cost beside it.
 */
export async function getAttributionCoverage(
  userIds: string[],
  since: Date,
): Promise<AttributionCoverage> {
  if (userIds.length === 0) {
    return EMPTY;
  }

  const uuids = Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<
    { linked_sessions: bigint; total_sessions: bigint }[]
  >(Prisma.sql`
    SELECT
      COUNT(DISTINCT session_id)                                       AS total_sessions,
      COUNT(DISTINCT session_id) FILTER (WHERE turn_number IS NOT NULL) AS linked_sessions
    FROM interactive_events
    WHERE user_id IN (${uuids})
      AND ts >= ${since}
  `);

  const row = rows[0];
  if (!row) {
    return EMPTY;
  }
  const totalSessions = Number(row.total_sessions);
  const linkedSessions = Number(row.linked_sessions);
  return {
    linkedSessions,
    ratio: totalSessions > 0 ? linkedSessions / totalSessions : null,
    totalSessions,
  };
}

/**
 * Totals the attributed values that exist, and returns null when none do.
 *
 * `[null, null]` must not become `0`: a window where nothing is attributable is
 * not a window that cost nothing, and a `$0.00` tile is the exact fiction these
 * columns replaced. Summing over a mix keeps the rows that do have a number —
 * the total is then a lower bound, which the coverage line beside it explains.
 */
export function sumAttributed(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((sum, v) => sum + v, 0);
}

/**
 * Adds two nullable attributions, treating null as "nothing to add" rather than
 * as zero — so a running total stays null until at least one real number joins
 * it. Plain `a + b` would silently turn `null` into `0` and print a measurement
 * where there is none.
 */
export function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : a + b;
}
