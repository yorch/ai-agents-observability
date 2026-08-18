import { Prisma } from '@ai-agents-observability/db';

/**
 * What is left of the `run_kind` guard after P13-012 moved it into the database.
 *
 * The rule is unchanged: CI and eval runs are stored and trendable, but never
 * enter a number a dashboard presents as developer behaviour. What changed is
 * where the rule lives. Human-facing SQL now reads the **filtered views**
 * `interactive_sessions` and `interactive_events` (`packages/db/sql/migrations/
 * 0003_run_kind_views.sql`) instead of filtering the base tables at ~130 call
 * sites. A query either names a filtered relation or it names a base table, and
 * naming a base table is a visible, greppable exception rather than an omission
 * nobody can see.
 *
 * Why that was worth doing, in one paragraph, because the history is the
 * argument. The predicate started inline and drifted, letting CI runs into org
 * spend — `getOrgSummary` reported 121 sessions and $547.83 against a true 115
 * and $19.03. Centralizing it here found 18 SQL and 22 ORM sites that had never
 * adopted it. Strengthening the lint to count per table per SQL literal then
 * found seven guards bound to a CTE while the driving query ran unfiltered. And
 * a later documentation audit still found two unguarded `events` reads in the
 * ingest alert engine, because that app had no counting lint at all. Four rounds,
 * each finding sites the previous round's mechanism could not see — the signature
 * of a rule enforced at the wrong altitude. Counting can prove a filter is
 * present; it cannot prove it is bound to the scan it was written for.
 *
 * The exemptions are unchanged and are now stated by *which relation a query
 * names*, marked with `run-kind-exempt: <reason>` beside the read:
 *
 * - **Per-session drill-downs.** A query already scoped to one `session_id` is
 *   not a population; filtering it renders a session's own detail page empty
 *   instead of excluding it from anything.
 * - **Mechanical jobs** that operate on rows rather than people — retention
 *   sweeps, transcript indexing, redaction backfill, and the per-session scorers,
 *   which must score every session they are asked about.
 * - **Own-data transcript search**, which lets a developer find their own CI and
 *   eval transcripts. That one read picks its relation from a caller-supplied
 *   scope (`search-queries.ts`), rather than always filtering.
 *
 * The three continuous aggregates need nothing: the filter is baked into their
 * definitions, so an aggregate named `daily_cost_by_user` cannot contain a
 * non-human run in the first place.
 *
 * `apps/web/test/run-kind-coverage.test.ts` now asks the smaller, fully decidable
 * question — does any query in `src/lib` name a base table without a marker? —
 * instead of counting fragments.
 *
 * ── What remains here, and why ───────────────────────────────────────────────
 *
 * Prisma ORM reads cannot be routed through a view without a model mapped to it,
 * so they still carry `runKind: 'INTERACTIVE'` in their `where`. Making that
 * structural is a client extension, which is a separate change with its own risk:
 * it inverts the default, so every read that legitimately sees all runs must opt
 * out, and there are more of those than there are guarded reads. Tracked as the
 * remaining half of `tasks/P13-012-run-kind-views.md`.
 *
 * The SQL fragments below are kept for the same reason — one caller
 * (`search-queries.ts`) still needs a relation chosen at run time, and deleting
 * these would leave nothing to point a future exemption at.
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
