import type { PrismaClient } from './generated/client/client';

/**
 * The `run_kind` guard for Prisma ORM reads (P13-012).
 *
 * The raw-SQL half of this guard is a pair of database views
 * (`interactive_sessions`, `interactive_events`), so a query either names a
 * filtered relation or names a base table, and naming a base table is visible in
 * the diff. ORM reads have no equivalent — `prisma.session.findMany()` looks
 * identical whether or not somebody remembered the filter.
 *
 * This closes that half by **inverting the default**: the client every dashboard
 * uses injects `runKind: 'INTERACTIVE'` into `session` reads, and a read that
 * legitimately sees every run has to ask for an unguarded client by name.
 *
 * The inversion is the point, and it is chosen for the *shape of its failures*
 * rather than for tidiness:
 *
 * - A forgotten guard, under the old default, produced an inflated aggregate.
 *   Nothing failed; a dashboard just quietly reported 121 sessions and $547.83
 *   against a true 115 and $19.03.
 * - A forgotten opt-out, under this default, produces an empty drill-down page.
 *   Loud, immediate, and attributable.
 *
 * Trading a silent wrong number for a visible missing one is the whole trade.
 *
 * **Scope: `session` reads only.** `events` is a TimescaleDB hypertable and is
 * not in `schema.prisma` at all, so there is no ORM path to it — the views cover
 * it. Writes are untouched: `run_kind` is set at ingest, and a guarded write
 * would silently refuse to update a CI session's own row.
 */

/** Read operations that return session rows and therefore need the filter. */
const GUARDED_OPERATIONS = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'aggregate',
  'count',
  'groupBy',
] as const;

/**
 * `findUnique` is deliberately absent. It is a lookup by primary key — a single
 * named session, not a population — and adding a non-key predicate to it is a
 * Prisma type error rather than a filter. Per-session drill-downs are exempt for
 * the same reason the raw-SQL side exempts them: a page already scoped to one id
 * must show that session's own data, not render empty.
 */
export type GuardedOperation = (typeof GUARDED_OPERATIONS)[number];

type AnyArgs = { where?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Wraps a client so every `session` read is scoped to interactive runs.
 *
 * An explicit `runKind` in the caller's `where` wins. That is not a loophole —
 * it is what lets a future "show me the CI runs" surface exist without reaching
 * for the unguarded client, and it keeps the ~19 call sites that already spell
 * the filter out working unchanged during the transition.
 */
export function withInteractiveOnly(client: PrismaClient): PrismaClient {
  return client.$extends({
    name: 'run-kind-interactive-only',
    query: {
      session: Object.fromEntries(
        GUARDED_OPERATIONS.map((op) => [
          op,
          ({ args, query }: { args: AnyArgs; query: (a: AnyArgs) => Promise<unknown> }) => {
            const where = (args.where ?? {}) as Record<string, unknown>;
            return query({
              ...args,
              where: 'runKind' in where ? where : { ...where, runKind: 'INTERACTIVE' },
            });
          },
        ]),
      ),
    },
    // The extension only narrows `where`, so the delegate's shape is unchanged
    // and the extended client stays assignable to `PrismaClient`. Asserting that
    // here keeps the ~40 call sites typed as `PrismaClient` from having to learn
    // an extension-branded type.
  }) as unknown as PrismaClient;
}
