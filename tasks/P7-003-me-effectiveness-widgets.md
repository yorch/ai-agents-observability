---
id: P7-003
title: /me effectiveness widgets (friction trend + shape mix)
phase: 7
workstream: E
status: review
owner: claude
depends_on: [P7-002]
blocks: []
estimate: M
---

## Goal

Render a friction-over-time trend widget and a session-shape distribution widget on
the /me dashboard, and add a friction badge with explanation to the session detail
page.

## Context

`friction_score` and `shape_label` have been stored in the DB since P5-001/P5-002
but no /me UI renders them. `DESIGN_DOC.md` §10.6 requires that widgets cite
`FRICTION_VERSION` and suppress numeric values for sessions the formula marks null
(insufficient data). The query data comes from the `getUserEffectiveness` helper
added in P7-002. Components live under `apps/web/src/components/me/` alongside
the existing `SessionsTable.tsx`.

## Acceptance criteria

- [ ] /me page shows a friction-over-time chart (line or area) covering the user's trailing 30d, using data from `getUserEffectiveness`.
- [ ] /me page shows a shape-distribution widget (bar or donut) showing the proportion of sessions per `ShapeLabel` for the same period.
- [ ] Both widgets display `FRICTION_VERSION` (e.g. "Friction v1") so users understand the signal is versioned.
- [ ] Sessions with null friction score are excluded from the trend line; the widget renders a "not enough data" notice when fewer than 3 scored sessions exist in the range.
- [ ] `/me/sessions/[id]` shows the session's `shape_label` and a friction band (Low / Medium / High, derived from the score) with a one-sentence plain-English explanation of what drove it.
- [ ] `/me/sessions/[id]` suppresses the friction band and shows "Insufficient data" when `friction_score` is null.
- [ ] Both pages load within the /me 500 ms p50 budget (measure with `console.time` in dev; no external profiling required).

## Implementation notes

Friction bands: Low = score < 0.3, Medium = 0.3–0.6, High > 0.6. Shape label copy:
map each `ShapeLabel` to a short description (e.g. "exploratory — heavy reading,
few edits"). Keep this mapping in the component, not in `packages/schemas`, since
it's UI copy.

Use React Server Components for the data fetch; pass serialisable props to thin
client chart components. The chart itself can be a lightweight Recharts
`<LineChart>` / `<BarChart>` — no new charting library unless one is already
present in `apps/web/package.json`.

## Files touched

- `apps/web/src/app/me/page.tsx`
- `apps/web/src/app/me/sessions/[id]/page.tsx`
- `apps/web/src/components/me/FrictionTrendChart.tsx` (new)
- `apps/web/src/components/me/ShapeDistributionChart.tsx` (new)
- `apps/web/src/components/me/FrictionBadge.tsx` (new)

## Out of scope

- Team or org effectiveness widgets (P7-004).
- Changing the friction formula or version (requires a separate task + FRICTION_VERSION bump).
- Exporting or sharing individual friction data.

## Verification

```bash
bun --filter '@app/web' test
bun run typecheck
bun run check
```

> **Verification status (review):** widgets + page wiring implemented;
> `biome check --error-on-warnings` is clean across all touched files. `typecheck` and the
> full app test run require the Prisma client (egress-denied `binaries.prisma.sh` in the
> sandbox) and run in CI. Visual/perf check of the rendered widgets is pending a running app.
