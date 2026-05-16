---
id: P1-018
title: Team sync cron job
phase: 1
workstream: C
status: blocked
owner: null
depends_on: [P1-015, P1-003]
blocks: []
estimate: S
---

## Goal

A scheduled job syncs `Team` and `TeamMember` rows from GitHub orgs nightly so that team-roster drift is bounded to one day. Also doubles as the worker host for the abandoned-session sweep mentioned in P1-011.

## Context

- Phase 1 doesn't use teams in the UI (per-user views only), but the data wants to be fresh by the time Phase 3 lands.
- Simple cron-style scheduler in-process; no need for a separate scheduling service yet.

## Acceptance criteria

- [ ] `apps/ingest/src/jobs/sync-teams.ts` (or its own `apps/worker` if scope grows — for now, in ingest) runs hourly:
  1. For each `User` with a stored GitHub token, list orgs.
  2. For each org, list teams; upsert into `Team`.
  3. For each team, list members; reconcile `TeamMember` rows (insert new, soft-delete removed via a `left_at` column).
- [ ] Scheduling via `node-cron` or a simple `setInterval` loop with jitter. Document the cadence in `PLAN.md` cross-cutting standards if it diverges.
- [ ] Abandoned-session sweep runs every 10 minutes: sessions with `status=active` and `last_event_at < now() - interval '24h'` get `status=abandoned`.
- [ ] All job runs write to a `JobRun` table (add to schema if needed) for observability: `job_name`, `started_at`, `finished_at`, `status`, `error_text`.
- [ ] Lock so two ingest replicas don't run the same job concurrently — use Postgres advisory locks keyed by job name.
- [ ] Test: mock GitHub responses, run sync once, assert Team/TeamMember rows match.

## Implementation notes

- Where to store the per-user GitHub token: at login, we hold an access token. Store the *refresh* token encrypted in the `User` row, refresh on demand for the sync. (Or just re-prompt if expired — Phase 3 problem.)
- The advisory lock pattern: `SELECT pg_try_advisory_lock(hashtext('job:sync-teams'))`.

## Files touched

- `apps/ingest/src/jobs/scheduler.ts`
- `apps/ingest/src/jobs/sync-teams.ts`
- `apps/ingest/src/jobs/sweep-abandoned.ts`
- `packages/db/prisma/migrations/<ts>_job_run/migration.sql`
- `apps/ingest/test/jobs.test.ts`

## Out of scope

- Real-time webhook-driven team membership (Phase 3+).
- Org-level GitHub App install (Phase 2).

## Verification

```bash
pnpm --filter=@app/ingest test
# Manual: trigger sync via an internal admin endpoint and inspect rows.
```
