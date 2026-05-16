---
id: P1-025
title: /me overview page
phase: 1
workstream: E
status: blocked
owner: null
depends_on: [P1-024, P1-011, P1-005]
blocks: [P1-029]
estimate: M
---

## Goal

The `/me` route shows the signed-in user a clear, glance-able summary of their own Claude Code usage for the trailing 7 and 30 days. This is the page that earns trust.

## Context

- `DESIGN_DOC.md` §12.1 — phase 1 ships my-data-only views.
- All queries scoped to `currentUser().id`.
- Page must load <500ms p50 against the seeded dataset (P1-005).

## Acceptance criteria

- [ ] `/me` is a Server Component page rendered at request time.
- [ ] Above-the-fold cards:
  - **This week**: session count, total cost, hours spent, # of repos touched.
  - **Last week** (delta): same metrics with arrow indicators.
  - **Top tools**: bar chart of tool usage by call count.
  - **Model mix**: pie/donut of input+output tokens by model.
- [ ] Below: "Recent sessions" — last 10 sessions as cards (repo · started_at · duration · cost · status).
- [ ] Each session card links to `/me/sessions/[id]` (page in P1-026).
- [ ] Empty state when user has zero sessions: friendly message + link to install instructions.
- [ ] Loading skeleton via `loading.tsx`.
- [ ] No client-side data fetching — all data via server components + Prisma.
- [ ] Charts via lightweight library (Tremor or Visx or hand-rolled SVG). No D3.
- [ ] Test: with seeded data, page renders all cards with non-zero values.

## Implementation notes

- React 19.2 Server Components throughout. Use `<Suspense>` with `loading.tsx` for the card grid.
- Tailwind 4: theme tokens come from the `@theme` block defined in `globals.css` (P1-024); reference via `bg-brand-500` etc.
- One Prisma query per card is fine for v1; revisit if p50 > 500ms. Run them in parallel with `Promise.all` inside the server component.
- Use Postgres `date_trunc('week', ...)` for week windows.
- Cost: use the precomputed `Session.cost_usd` aggregates (P1-011) — don't sum events at read time.

## Files touched

- `apps/web/src/app/me/page.tsx`
- `apps/web/src/app/me/loading.tsx`
- `apps/web/src/components/me/{SummaryCards,TopTools,ModelMix,RecentSessions}.tsx`
- `apps/web/src/lib/me-queries.ts`
- `apps/web/test/me.test.ts`

## Out of scope

- Cross-user comparison (Phase 3).
- Date-range picker (assume rolling windows for v1).

## Verification

```bash
pnpm --filter=@pkg/db db:seed
pnpm --filter=@app/web dev
# Visit http://localhost:3000/me — all cards populated.
pnpm --filter=@app/web test
```
