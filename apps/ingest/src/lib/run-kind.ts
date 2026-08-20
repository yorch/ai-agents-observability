import { Prisma } from '@ai-agents-observability/db';

/**
 * The ingest-side counterpart to `apps/web/src/lib/run-kind.ts` (P13-002).
 *
 * Non-interactive runs — CI and eval — are stored in full, but never contribute
 * to anything that reports on *people*. On the web side that means every
 * dashboard query; here it means the jobs that report on humans (the alert
 * engine) and the scorers whose output feeds those dashboards.
 *
 * This exists as a module rather than nine inline `run_kind = 'INTERACTIVE'`
 * strings for the same reason the web one does, and the reason is not
 * aesthetic: on the web side the equivalent predicate *was* inline, drifted, and
 * silently let CI runs into org spend. A single fragment is greppable, and a
 * missing one is visible as an absent import.
 *
 * **Deliberately not applied** to three classes of read, each of which states its
 * reason inline with a `run-kind-exempt:` marker that
 * `test/run-kind-fragment.test.ts` requires:
 *
 * 1. **Jobs that operate on rows rather than people** — retention sweeps,
 *    transcript indexing, redaction backfill, and repricing. A CI session's
 *    transcript occupies S3 and its `cost_usd` goes stale exactly like anyone
 *    else's; skipping it leaves it permanently unswept or mispriced.
 * 2. **Per-session scorers** — a CI session's friction score is a property of
 *    that session. Withholding it would make the row unexplainable rather than
 *    excluded.
 * 3. **Comparisons against an unfiltered external ground truth** — `reconcile-cost`
 *    sums client-computed cost against the vendor's monthly invoice, and the
 *    vendor bills every token the account sends. There is no "interactive only"
 *    line item to reconcile against, so filtering here would manufacture a
 *    permanent drift against a number that was never meant to match.
 */

/** For `FROM sessions` with no alias. */
export const INTERACTIVE_SESSIONS = Prisma.sql`sessions.run_kind = 'INTERACTIVE'`;

/** For `FROM events` with no alias. */
export const INTERACTIVE_EVENTS = Prisma.sql`events.run_kind = 'INTERACTIVE'`;

/**
 * Aliased forms. The alias is a closed union of the aliases actually used in this
 * app, and each case returns a fully-literal `Prisma.sql`, so no identifier is
 * ever interpolated into SQL and there is no `Prisma.raw` here. Adding an alias
 * means adding a case — which keeps the set small and visible.
 */
export type SessionAlias = 's';
export type EventAlias = 'e';

export function interactiveSessions(alias: SessionAlias): Prisma.Sql {
  switch (alias) {
    case 's':
      return Prisma.sql`s.run_kind = 'INTERACTIVE'`;
  }
}

export function interactiveEvents(alias: EventAlias): Prisma.Sql {
  switch (alias) {
    case 'e':
      return Prisma.sql`e.run_kind = 'INTERACTIVE'`;
  }
}
