---
id: P13-012
title: Move the run_kind guard from call sites into the data layer
phase: 13
workstream: A
status: review
owner: claude
depends_on: [P13-002]
blocks: []
estimate: M
---

## Goal

Make it structurally impossible for a query to forget the `run_kind` filter, by
moving the guard out of ~110 hand-written call sites and into the data layer —
filtered views for the raw-SQL paths, a Prisma client extension for the ORM paths.

## Context

[`P13-002`](./P13-002-run-kind-dimension.md) centralized the predicate into
`apps/web/src/lib/run-kind.ts` and `apps/ingest/src/lib/run-kind.ts`, and put two
source-scanning lints behind it. That was the right first move and it is not the
end state.

The evidence is this project's own history. In one branch the guard was:

1. spelled inline, where it drifted and let CI runs into org spend —
   `getOrgSummary` reported 121 sessions and $547.83 against a true 115 and $19.03;
2. centralized into a fragment, after which the lint found **18 SQL and 22 ORM**
   call sites that had simply not adopted it;
3. strengthened to count per table per SQL literal, which then caught seven guards
   bound to a CTE while the driving query ran unfiltered;
4. and *still* missed both `events` reads in the ingest alert engine, because that
   app had no counting lint at all until a documentation audit went looking.

Four rounds, each one finding sites the previous round's mechanism could not see.
That is the signature of a rule enforced at the wrong altitude: every fix makes
the *checker* better while the thing being checked stays a convention that ~110
places have to remember.

A filtered view and a client extension move it from "remembered correctly 110
times" to "expressed once". The lints stay — they become a check on the exemptions
rather than on the rule.

## Acceptance criteria

- [x] Human-facing reads go through filtered views (e.g. `interactive_sessions`,
      `interactive_events`) rather than the base tables. The view definitions live
      in `packages/db/sql/migrations/`. *Landed as a new numbered file, then folded
      into `0001_init.sql` by the 2026-08-18 pre-deployment squash — see
      `packages/db/AGENTS.md`.*
- [x] Prisma ORM reads are guarded by a client extension, so `prisma.session.findMany()`
      cannot silently include non-interactive runs. The extension is applied where
      the client is constructed, not per call site.
- [x] The three read classes that legitimately see every run are unchanged and
      explicit: per-session drill-downs, the mechanical jobs (retention, transcript
      indexing, redaction backfill), and the per-session scorers. Each reaches the
      base table by name, and that name is what marks it as an exemption.
- [x] `run-kind-coverage.test.ts` and `run-kind-fragment.test.ts` are **repurposed,
      not deleted** — they should now assert that no human-facing module reads a base
      table directly, which is a cheaper and more honest question than counting
      fragments.
- [x] Verified against a live database with CI/EVAL fixtures seeded: the org summary
      figures match the pre-change guarded values exactly. A refactor of this size
      is only safe if the numbers are proven unchanged, not assumed.
- [x] No behaviour change is bundled in. This task moves a filter; it does not
      adjust what any dashboard reports.

## Implementation notes

- Sequence it as views first, then the extension, then the call-site sweep — each
  is independently revertible, and a single commit spanning all three is not
  reviewable.
- A view over a TimescaleDB hypertable does not inherit the hypertable's
  chunk-exclusion behaviour automatically in every query shape. Check the plans on
  the `events` view before assuming performance is neutral; a filtered view that
  defeats chunk pruning would be a large regression on the firehose.
- The three continuous aggregates already bake the filter into their definitions
  and need nothing here.

## Out of scope

- Changing which runs are excluded, or adding a surface that reports on CI/eval
  runs — that is the deferred criterion in `P13-002`.
- Touching the ingest write path. `run_kind` is set at ingest and this task only
  concerns reads.

## Verification

```bash
bun run check
bun run typecheck
bun run build
bun run test
# plus the live-database comparison named in the acceptance criteria
```

## Implementation record — part 1 of 2

Landed 2026-08-18: the views, the SQL sweep, and the repurposed lints. The client
extension is deliberately a separate change; this task's own implementation notes
asked for that sequencing, and the reason held up.

**The views.** `interactive_sessions` and `interactive_events` in
`sql/migrations/0001_init.sql`. The performance question was settled
before committing to the approach rather than after: the planner inlines a simple
view, so `EXPLAIN` on `interactive_events` and on the equivalent filtered `events`
query produce **byte-identical plans** — same ChunkAppend, same index choice, 3 of
30 chunks scanned either way. TimescaleDB chunk exclusion is unaffected.

**The sweep** rewrote 132 table references and removed 122 fragments across 17
files. It was done per SQL template literal, not per file: a literal that already
carried a guard was rewritten, and a literal without one was left completely
alone. That distinction is load-bearing — a first, blunter pass keyed on table
names alone silently guarded `sessions-queries.ts` and `compute-effectiveness.ts`,
which are deliberately exempt, and had to be reverted.

**The sweep introduced one real bug, and a test caught it.** `search-queries.ts`
picks its run-kind scope at run time — org search filters, own-data search does
not, so a developer can find their own CI transcripts. The blanket fragment
removal collapsed both branches of that ternary to empty, which would have
silently stopped org-wide transcript search from filtering. It now switches the
**relation** rather than a predicate (`interactive_sessions s` vs `sessions s`),
both branches fully-literal `Prisma.sql`, so no identifier is interpolated.

**Verification.** 22 org-rollup functions were called against a live seeded
TimescaleDB instance before and after: **zero differences**. `getOrgSummary`
returns 120 sessions / $19.41 either way.

**The lints changed shape rather than being deleted.** The web lint used to count
guards per table per SQL literal; it now asks whether any query in `src/lib` names
a base table without a `run-kind-exempt:` marker within twelve lines. That is a
smaller and fully decidable question — counting can prove a filter is present but
never that it is bound to the right scan, which is how seven CTE-misplaced guards
once passed. The ORM half of the lint stays as a counting check until the
extension lands.

## Implementation record — part 2 of 2

Landed 2026-08-18: the Prisma client extension. It was held back from part 1 because
it **inverts the default** — every read that legitimately sees all runs now has to
opt out — and that inversion had to be argued call site by call site rather than
swept.

**The extension.** `packages/db/src/run-kind-client.ts` exports
`withInteractiveOnly(client)`, which wraps the six `session` operations that return
a population (`findFirst`, `findFirstOrThrow`, `findMany`, `aggregate`, `count`,
`groupBy`) and injects `runKind: 'INTERACTIVE'` when the caller has not named
`runKind` itself. `findUnique` is deliberately **not** wrapped: it is a primary-key
lookup, so filtering it can only turn a valid drill-down into a 404. An explicit
`runKind` in the caller's `where` always wins, which is what keeps the CI/eval
surfaces of `P13-002` reachable.

**Two accessors, one pool.** `apps/web/src/lib/prisma.ts` now exposes `getPrisma()`
(guarded) and `getAllRunsPrisma(reason)` (not). `$extends` wraps the existing client
rather than opening a second one, so the exemption costs no connections. The
required-but-unused `reason` argument is the same device `readScores` uses for
`aggregate-only` access: it forces the exemption to appear in the diff as a claim
rather than as an absence. Six call sites take it — two transcript routes, the
adapter inventory, org search, the own-sessions facet counts, and two functions in
the session-detail actions.

**A global-key collision made the first version a no-op.** `packages/db` publishes
a module-level client on `globalThis._prisma` outside production. This file cached
under the same key, so importing the db package anywhere pre-populated the cache
with an **unguarded** client and `getPrisma()` handed it straight back. Harmless
while both were the same object; a silently missing filter the moment one of them
carried a guard. Fixed by caching under `_prismaGuarded`, and pinned by an assertion
that the factory does not read `_prisma`.

**The first verification pass was vacuous, which is the part worth remembering.** A
before/after snapshot diff across the ORM call sites reported *zero differences* —
against an extension that was not running at all, because of the key collision
above. Zero differences is exactly what a correct refactor and a dead code path both
produce. Only a direct probe separated them: `getPrisma().session.count({})`
returning **124** against `getAllRunsPrisma().session.count({})` returning **130**,
a guarded `groupBy` yielding INTERACTIVE rows only, and an explicit
`runKind: 'CI'` still returning its 4. The snapshot diff was then re-run against a
proven-live extension — 9 probes, 0 differences.

**The lint's ORM half changed from counting to structure.** It no longer counts
guards; it asserts that `getPrisma` applies `withInteractiveOnly`, that the factory
does not use the colliding global key, and that every `getAllRunsPrisma(` call
carries a `run-kind-exempt:` marker. Both new assertions were mutation-verified.
Thirteen web test suites that mock `@ai-agents-observability/db` gained an identity
`withInteractiveOnly` export.

**The ~19 now-redundant explicit `runKind: 'INTERACTIVE'` filters were left in
place.** They resolve to the same value the extension injects, they document intent
at the call site, and removing them is a diff whose only effect is to make the guard
less visible.
