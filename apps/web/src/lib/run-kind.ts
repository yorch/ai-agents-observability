import { Prisma } from '@ai-agents-observability/db';

/**
 * The single definition of "sessions a human actually had" (P13-002).
 *
 * CI and eval runs have no human prompts, so mixing them into per-developer
 * metrics distorts every one of them — the concern `DESIGN_DOC.md` §13 Q8 raises
 * about CI-side runs. They are stored and trendable; they are just never part of a
 * human aggregate.
 *
 * Every read of `sessions` or `events` in a user-facing surface must carry one of
 * these fragments. That is enforced by `run-kind-coverage.test.ts`, which scans
 * this directory rather than trusting review — a missed site would silently let
 * non-interactive runs into an aggregate, and nothing would fail. It counts
 * guards against table reads *per SQL literal*, so a multi-CTE query that scans
 * `events` three times needs three of them; it also scans Prisma ORM reads of
 * `session`/`event`, which carry `runKind: 'INTERACTIVE'` instead of a fragment.
 * A read that legitimately sees every run says so with a `run-kind-exempt:
 * <reason>` marker next to it.
 *
 * Placement is on you, though. Counting proves nobody forgot to think about a
 * read; it cannot prove a filter is bound to the read it was meant for. The two
 * mistakes worth naming, because both have shipped here:
 *
 * - **Guarding the join instead of the scan.** Putting the filter on a
 *   `LEFT JOIN sessions` while the driving `FROM events` runs unfiltered yields a
 *   row whose counts cover everyone and whose averages cover only humans. On a
 *   LEFT JOIN the filter also nulls rather than excludes, which is worse still
 *   when the column is typed non-nullable downstream.
 * - **Guarding one sibling CTE.** Two CTEs over the same table, one filtered,
 *   produce a comparison between different populations — a "users on this server"
 *   total larger than the sum of its parts, or a CI-only user counted as a
 *   returning human.
 *
 * Deliberately *not* applied to per-session drill-downs. A query already scoped to
 * one `session_id` is not a population, and filtering it renders a session's own
 * detail page empty instead of excluding it from anything.
 *
 * Deliberately *not* applied to mechanical jobs that must see every session
 * (retention sweeps, transcript indexing, redaction backfill, effectiveness
 * scoring): those operate on rows, not on people.
 *
 * The three continuous aggregates need no fragment at all — the filter is baked
 * into their definitions (`packages/db/sql/migrations/0008`), because an aggregate
 * named `daily_cost_by_user` that feeds a developer dashboard should not be able
 * to contain non-human runs in the first place.
 *
 * **Aliases are a closed union rather than a string.** Every fragment below is a
 * fully-literal `Prisma.sql`, so no identifier is ever interpolated into SQL and
 * there is no `Prisma.raw` anywhere in this module. Adding an alias means adding a
 * case here, which is the point: the set stays small and visible.
 */

/** Table aliases used for `sessions` across the query layer. */
export type SessionAlias = 's';

/** Table aliases used for `events` across the query layer. */
export type EventAlias = 'e';

/** For `FROM sessions` with no alias. */
export const INTERACTIVE_ONLY = Prisma.sql`sessions.run_kind = 'INTERACTIVE'`;

/** For an aliased `FROM sessions s` / `JOIN sessions s`. */
export function interactiveOnly(alias: SessionAlias): Prisma.Sql {
  switch (alias) {
    case 's':
      return Prisma.sql`s.run_kind = 'INTERACTIVE'`;
  }
}

/**
 * For `FROM events` with no alias. The hypertable carries its own `run_kind`,
 * denormalized at ingest rather than joined, because most event read paths never
 * touch `sessions`.
 */
export const INTERACTIVE_EVENTS = Prisma.sql`events.run_kind = 'INTERACTIVE'`;

/** For an aliased `FROM events e` / `JOIN events e`. */
export function interactiveEvents(alias: EventAlias): Prisma.Sql {
  switch (alias) {
    case 'e':
      return Prisma.sql`e.run_kind = 'INTERACTIVE'`;
  }
}
