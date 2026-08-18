---
id: P13-012
title: Move the run_kind guard from call sites into the data layer
phase: 13
workstream: A
status: ready
owner: null
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

- [ ] Human-facing reads go through filtered views (e.g. `interactive_sessions`,
      `interactive_events`) rather than the base tables. The view definitions live
      in `packages/db/sql/migrations/` as a **new numbered file** — never by editing
      `0001_init.sql`.
- [ ] Prisma ORM reads are guarded by a client extension, so `prisma.session.findMany()`
      cannot silently include non-interactive runs. The extension is applied where
      the client is constructed, not per call site.
- [ ] The three read classes that legitimately see every run are unchanged and
      explicit: per-session drill-downs, the mechanical jobs (retention, transcript
      indexing, redaction backfill), and the per-session scorers. Each reaches the
      base table by name, and that name is what marks it as an exemption.
- [ ] `run-kind-coverage.test.ts` and `run-kind-fragment.test.ts` are **repurposed,
      not deleted** — they should now assert that no human-facing module reads a base
      table directly, which is a cheaper and more honest question than counting
      fragments.
- [ ] Verified against a live database with CI/EVAL fixtures seeded: the org summary
      figures match the pre-change guarded values exactly. A refactor of this size
      is only safe if the numbers are proven unchanged, not assumed.
- [ ] No behaviour change is bundled in. This task moves a filter; it does not
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
