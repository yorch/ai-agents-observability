---
id: P10-004
title: Team + individual routing guidance
phase: 10
workstream: E
status: ready
owner: null
depends_on: [P10-001]
blocks: []
estimate: M
---

## Goal

Bring model-routing and cache-efficiency guidance to the personas who can actually
change behavior: team leads (`/team/[slug]`) and individual developers
(`/me/insights`). Individual guidance is individual-value-first and privacy-aware,
reusing the friction-coaching pattern.

## Context

See [`P10-roadmap.md`](./P10-roadmap.md) and `OPPORTUNITIES.md` §5 ("every new
analysis surface must first answer: what does the individual developer get from
this?"). Model optimization is org-only today; a leadership number nobody
downstream can act on doesn't reduce spend.

`/me/insights` already has the right pattern: `buildRecommendations()` in
`apps/web/src/lib/recommendations.ts` produces gated, sorted, suggestion-framed tips
from already-fetched data. Routing/cache tips should extend that pattern, not build a
parallel one.

## Acceptance criteria

- [ ] `/team/[slug]` shows team routing opportunities (by task type) and a team
      cache-efficiency figure with guidance, honoring `share_metadata_with_team` — no
      individual member's routing detail is exposed to the lead beyond existing
      drill-in rules.
- [ ] `/me/insights` surfaces at least one routing/cache recommendation when the
      developer's own data warrants it (e.g. "you ran a premium model for mostly
      read-only work — a standard model would likely cover it"; "your cache-read ratio
      is low — resume sessions instead of restarting"), framed as a suggestion.
- [ ] Recommendations are **gated**: none appear when the developer's data is thin or
      already efficient (no nagging, no false positives). Thresholds unit-tested.
- [ ] Individual routing recommendations are derived only from the requesting user's
      own sessions and never leak cross-user.
- [ ] The tip logic is a pure function over already-fetched inputs (extends
      `buildRecommendations()`), unit-tested for the show/suppress boundaries.

## Implementation notes

- Extend `recommendations.ts` with routing/cache recommendation kinds; reuse the
  warn-before-info sort and the `MIN_*` gating style.
- Team view reuses `P10-001`'s query scoped to team-visible users.
- No new heavy queries on `/me/insights` if the existing model/cache data already
  fetched there suffices — keep it a derivation.

## Files touched

- `apps/web/src/lib/recommendations.ts` (+ test)
- `apps/web/src/app/me/insights/page.tsx`
- `apps/web/src/app/team/[slug]/page.tsx` (or a team models sub-page)
- `apps/web/src/components/me/RecommendationsSection.tsx` (extend)

## Out of scope

- Org dashboard (P10-003) and governance enforcement (P10-005).

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test recommendations
bun run --cwd apps/web typecheck
# Manual: an efficient seeded user shows no routing nag; an Opus-on-reads user does.
```
