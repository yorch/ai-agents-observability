---
id: P7-002
title: Effectiveness query layer (web)
phase: 7
workstream: E
status: blocked
owner: null
depends_on: [P7-001]
blocks: [P7-003, P7-004]
estimate: S
---

## Goal

Add query helpers to the web app that expose `friction_score` and `shape_label`
(and their aggregate distributions) for a user, team, or org, with on-the-fly
fallback computation when the DB value is null.

## Context

P7-001 backfills historical sessions so DB coverage is high, but null values will
always exist (low-data sessions per `packages/schemas/src/effectiveness.ts`). The
query layer must exclude nulls from averages rather than treating them as 0.
`DESIGN_DOC.md` §10.6 (Effectiveness Caveat) is the governing rule: never present
a misleading number for sessions without sufficient data.

The web app already has `apps/web/src/lib/effectiveness.ts` (on-the-fly
`computeFrictionScore` + `classifySessionShape` wrappers) and
`apps/web/src/lib/sessions-queries.ts` (per-user session list). The new helpers
sit alongside these and are consumed by P7-003 (/me widgets) and P7-004 (team/org).

## Acceptance criteria

- [ ] `getUserEffectiveness(userId, range)` returns an array of `{ date, frictionScore }` trend points (one per day or session bucket) and a `{ [label]: count }` shape histogram, using DB values where present and falling back to on-the-fly computation otherwise.
- [ ] Null/low-data sessions are excluded from friction averages and percentile calculations; they do not count as 0.
- [ ] Aggregate helpers (`getTeamEffectivenessDistribution`, `getOrgEffectivenessDistribution`) return friction percentile buckets (p25/p50/p75) and shape mix proportions for use by the team and org dashboards.
- [ ] All helpers are unit-tested with mock DB data covering: all nulls, partial nulls, and fully populated datasets.
- [ ] No raw `prisma.$queryRaw` calls duplicated from `sessions-queries.ts`; shared predicates are extracted.

## Implementation notes

`getUserEffectiveness` can join directly on `sessions` — `friction_score` and
`shape_label` are scalar columns. For the trend line, group by
`DATE_TRUNC('day', started_at)` and take `AVG(friction_score)` filtering
`WHERE friction_score IS NOT NULL`. The on-the-fly fallback path (recompute from
session aggregate columns) is useful only for the very latest sessions that haven't
cleared the nightly job yet — keep it fast and cheap (no extra event table join).

For percentile distribution, `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY friction_score)`
in Postgres works directly on the column.

## Files touched

- `apps/web/src/lib/effectiveness-queries.ts` (new)
- `apps/web/src/lib/sessions-queries.ts`

## Out of scope

- UI rendering (P7-003, P7-004).
- Visibility-policy enforcement (handled in the callers for team/org routes).
- Caching / memoisation (add only if measured as slow).

## Verification

```bash
bun --filter '@app/web' test
bun run typecheck
```
