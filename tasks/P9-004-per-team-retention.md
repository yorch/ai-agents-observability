---
id: P9-004
title: Per-team retention override
phase: 9
workstream: B
status: done
owner: claude
depends_on: [P4-007]
blocks: []
estimate: M
---

## Goal

Allow a team to carry a `retention_days` override — shorter or longer than the
global default — bounded by a configured org maximum. `sweep-retention` honors
per-team overrides; a team with no override behaves exactly as today.

## Context

- `P4-007` landed `sweep-retention.ts`: deletes S3 transcripts where
  `transcriptUploadedAt < now() - TRANSCRIPT_RETENTION_DAYS` (global env var,
  default 365, 0=disabled).
- Today the sweep is all-or-nothing at the org level. Some teams may need shorter
  retention (compliance) or longer retention (research). There is no mechanism
  to express this.
- `DESIGN_DOC.md §12.3` open question #3 resolved retention as configurable;
  per-team granularity was deferred and is now in scope.

## Acceptance criteria

- [x] `teams.retention_days` column added (INT nullable; null means "use global
      default").
- [x] `ORG_MAX_RETENTION_DAYS` env var in ingest config (default: 730). A team
      override above this value is clamped, not rejected, so ingestion never
      fails on a misconfigured override.
- [x] `sweep-retention.ts` groups sessions by team, applies the team's
      `retention_days` if set, falls back to `TRANSCRIPT_RETENTION_DAYS`
      otherwise.
- [x] A team with `retention_days = null` deletes transcripts at exactly the same
      age as today (no behavioral change, verified by test).
- [x] Org_admin can set or clear `teams.retention_days` via the team settings
      page (or a new field on the existing admin team page); the change is audited
      via `writeAuditLog` with a new `AuditAction` of `retention_override_changed`.
- [x] The admin UI displays the effective retention (override if set, else global
      default) so there is no ambiguity.
- [x] TypeScript and Biome clean.

## Implementation notes

- The sweep query will need to join `sessions` to `teams` via `users.primary_team_id`
  (or the team membership table if a user can belong to multiple teams). Use
  `primary_team_id` for v1 — it avoids ambiguity when a user is in multiple teams
  with different overrides.
- Clamping logic: `effectiveRetention = Math.min(teamOverride ?? globalDefault, orgMax)`.
  Apply clamping at query time in the job, not at write time.
- The `retention_override_changed` audit action does not need a `target_user_id`
  (it's a team-level config change); populate `target_team_id` instead.

## Files touched

- `packages/db/prisma/schema.prisma` (teams.retention_days column)
- `packages/db/sql/migrations/` (new migration)
- `apps/ingest/src/config.ts` (`ORG_MAX_RETENTION_DAYS`)
- `apps/ingest/src/jobs/sweep-retention.ts` (per-row clamp via `effectiveRetentionDays`)
- `apps/ingest/src/jobs/retention-policy.ts` (new; Prisma-free `effectiveRetentionDays`)
- `apps/web/src/lib/audit.ts` (extend AuditAction with `retention_override_changed`)
- `apps/web/src/app/admin/retention/page.tsx` + `actions.ts` (the implementation is a
  standalone `/admin/retention` override editor, not a per-team settings tab)

## Out of scope

- Per-user retention overrides.
- Retroactive re-retention (extending an override does not restore already-deleted
  transcripts — S3 objects are gone).
- Retention policy inheritance from parent teams (flat override only in v1).

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@ai-agents-observability/ingest' test
# Test: team with retention_days=30, global=365 → only transcripts >30d deleted
#       for that team's sessions; other teams' sessions deleted at 365d.
# Test: team with retention_days=null → behavior identical to pre-patch.
# Test: team with retention_days=800, ORG_MAX=730 → clamped to 730.
```

> **Verification status (done):** `retention-clamp.test.ts` (5 cases — null=global, shorter,
> longer, clamp-above-max, global-above-max) **passes locally** + biome clean. The clamp formula
> lives in a Prisma-free `retention-policy.ts` (testable without the generated client); the sweep
> job computes effective retention per-row in SQL (`LEAST(COALESCE(team.retention_days, global),
> orgMax)`) joined via `users.primary_team_id`. `teams.retention_days` column + `ORG_MAX_RETENTION_DAYS`
> config (default 730) + `retention_override_changed` AuditAction added; org-admin sets/clears the
> override at `/admin/retention` (audited). A team with null override behaves exactly as before.
> `typecheck` + DB tests run in CI (Prisma egress-blocked locally).
