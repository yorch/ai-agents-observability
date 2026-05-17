---
id: P1-005
title: Seed script for local dev
phase: 1
workstream: A
status: blocked
owner: null
depends_on: [P1-003, P1-004]
blocks: [P1-025, P1-026]
estimate: S
---

## Goal

`bun --filter '@pkg/db' db:seed` produces a realistic-enough local dataset so frontend devs can build UI without running the hook end-to-end.

## Context

- Phase 1 UI is per-user; one demo user is enough.
- Phase 2 dashboards need PRs; seed includes a handful for forward compatibility.

## Acceptance criteria

- [ ] One `User` (`demo@example.com`, display "Demo Dev"), one `Team`, one `Repo`.
- [ ] One `VisibilityPolicy` row for the demo user with defaults from `DESIGN_DOC.md` §10 (transcripts not shared, costs not shared).
- [ ] 30 days of `Session` rows (~3/day, varied durations + costs).
- [ ] 5–10 `events` per session inserted into the hypertable, covering tool calls, model usage, errors.
- [ ] 5 `PullRequest` rows linked via `SessionPRLink`; 3 merged with `PRRollup` rows.
- [ ] Idempotent: re-running the seed truncates seeded rows first (via a `seed_marker` column or a known prefix on IDs) and recreates.
- [ ] Cost numbers consistent with the v1 price table (so `/me` totals match expectations).

## Implementation notes

- Use `@faker-js/faker` for varied names / commit SHAs.
- Pick session durations from a long-tail distribution (most short, a few multi-hour) — realistic for UI testing.
- Don't seed `AuthToken`; auth flow is exercised by P1-016/P1-017.

## Files touched

- `packages/db/src/seed.ts`
- `packages/db/package.json` (`db:seed` script)

## Out of scope

- Multi-tenant seed (multiple teams) — Phase 3.
- Anonymized real data ingest.

## Verification

```bash
docker compose -f infra/docker-compose.yml up -d postgres
docker compose -f infra/docker-compose.yml run --rm migrations
bun --filter '@pkg/db' db:seed
psql "$DATABASE_URL" -c "SELECT count(*) FROM \"Session\" WHERE user_id IN (SELECT id FROM \"User\" WHERE email='demo@example.com');"
# Expect ~90
bun --filter '@pkg/db' db:seed   # idempotent
```
