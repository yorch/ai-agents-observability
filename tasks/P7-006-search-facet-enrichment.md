---
id: P7-006
title: Search facet enrichment (shape, friction band, agent type)
phase: 7
workstream: E
status: blocked
owner: null
depends_on: [P4-002, P7-001]
blocks: []
estimate: S
---

## Goal

Add `shape_label`, friction band, and `agent_type` as filterable facets on the
existing faceted session search, so users and org admins can slice results by
effectiveness signals alongside the existing repo/model/tool/date filters.

## Context

Faceted session search exists at `/org/search` (filters: team, repo, model, tool,
date) via `apps/web/src/lib/org-queries.ts`, and a lighter version on the /me
session list via `apps/web/src/lib/sessions-queries.ts`. These queries already
join `sessions`; `shape_label`, `friction_score`, and `agent_type` are scalar
columns on the same table — they are cheap to add as `WHERE` predicates.

P7-001 is a dependency because friction-band filtering is only meaningful once
historical sessions have scores; before the backfill a filter on `friction_score`
would return nearly empty results for sessions older than 48h.

Friction band is a derived filter (Low/Medium/High) not a stored column. Map it
to a range predicate at query time: Low = `friction_score < 0.3`, Medium =
`friction_score BETWEEN 0.3 AND 0.6`, High = `friction_score > 0.6`. Sessions
with `friction_score IS NULL` never match any band filter.

## Acceptance criteria

- [ ] `/org/search` gains a `shape_label` multi-select filter; selecting one or more labels restricts results to sessions with matching `shape_label`.
- [ ] `/org/search` gains a friction-band filter (Low / Medium / High); selecting a band restricts to the corresponding `friction_score` range; null-score sessions are excluded from all band results.
- [ ] `/org/search` gains an `agent_type` filter; selecting a type restricts results to sessions with that `agent_type`.
- [ ] `/me` session list gains the same three filters (shape, friction band, agent type) consistent with the org search UX.
- [ ] Facet counts reflect actual available values in the current result set (i.e. a shape with zero matches in the current filter context is not shown or shows count 0).
- [ ] New filters compose correctly with all existing filters (repo, model, tool, date, team); the query does not AND-in a filter that was not explicitly selected.
- [ ] URL query params encode the new filter state so results are bookmarkable/shareable.

## Implementation notes

Add `shapeLabels?: ShapeLabel[]`, `frictionBand?: 'low' | 'medium' | 'high'`, and
`agentTypes?: string[]` to the filter param types in `org-queries.ts` and
`sessions-queries.ts`. Build the WHERE clause conditionally — only append the
predicate when the value is set. This mirrors how the existing `model` and `tool`
filters are appended today.

For facet counts on `/org/search`, a single `GROUP BY shape_label` aggregation
query over the unfiltered base scope is sufficient; do not run N queries.

## Files touched

- `apps/web/src/lib/org-queries.ts`
- `apps/web/src/lib/sessions-queries.ts`
- `apps/web/src/app/org/search/page.tsx`

## Out of scope

- Adding effectiveness facets to the PR search or GitHub-related views.
- Friction-score range slider (band buckets only for Phase 7).
- Saving/pinning filter presets.

## Verification

```bash
bun --filter '@app/web' test
bun run typecheck
bun run check
```
