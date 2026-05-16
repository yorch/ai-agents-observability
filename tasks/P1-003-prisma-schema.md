---
id: P1-003
title: Prisma schema for dimensional tables
phase: 1
workstream: A
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-004, P1-005, P1-010, P1-018, P1-027]
estimate: M
---

## Goal

`packages/db` ships a Prisma schema covering every dimensional (non-time-series) table the system needs, plus a generated typed client other packages can import.

## Context

- See `DESIGN_DOC.md` §8 for the full data model.
- The `events` hypertable is **out of scope** here — that's P1-004 (raw SQL).
- Prisma can't manage hypertables, so we keep `events` in a parallel raw-SQL migration. Prisma stays unaware of it (no model, or `@@ignore`).

## Acceptance criteria

- [ ] `packages/db/prisma/schema.prisma` defines models for:
  - `User` (`id`, `external_id`, `email`, `display_name`, `created_at`)
  - `Team` (`id`, `slug`, `name`, `external_id`, `created_at`)
  - `TeamMember` (`team_id`, `user_id`, `role_in_team`, joined_at)
  - `Repo` (`id`, `host`, `owner`, `name`, `default_branch`, `created_at`) — unique `(host, owner, name)`
  - `Session` (matches `DESIGN_DOC.md` §8 schema, minus `events` reference)
  - `PullRequest` (per §8; populated in Phase 2 but model exists now)
  - `SessionPRLink`
  - `PRRollup`
  - `VisibilityPolicy` (`user_id` unique, the four boolean fields)
  - `AuditLog` (`id`, `timestamp`, `actor_user_id`, `subject_user_id`, `action`, `target_kind`, `target_id`, `query_text`)
  - `AuthToken` (`id`, `user_id`, `token_hash`, `kind` enum {access,refresh,hook}, `expires_at`, `revoked_at`)
- [ ] Enums declared for `Session.status`, `Session.agent_type`, `AuditLog.action`, `AuthToken.kind`.
- [ ] Foreign keys + cascade rules per §8.
- [ ] Indexes per §8.4 (`sessions(user_id, started_at desc)`, `sessions(repo_id, started_at desc)`, `pr_rollups(repo_id, merged_at desc)`).
- [ ] `prisma migrate dev --name=init` produces a clean initial migration committed to `packages/db/prisma/migrations/`.
- [ ] `packages/db` exports a `PrismaClient` singleton from `src/index.ts`.
- [ ] Unit test in `packages/db/test/schema.test.ts` connects to the docker-compose Postgres and round-trips one row per table.

## Implementation notes

- Use `cuid()` for IDs unless §8 specifies otherwise.
- Store all timestamps as `TIMESTAMPTZ` (`@db.Timestamptz`).
- For JSON-shaped columns (e.g. `Session.session_context`), use `Json` type.
- The Prisma singleton should attach to `globalThis` in dev to avoid client churn under HMR.

## Files touched

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/<timestamp>_init/migration.sql`
- `packages/db/src/index.ts`
- `packages/db/test/schema.test.ts`
- `packages/db/package.json` (scripts: `db:generate`, `db:migrate`, `db:studio`)

## Out of scope

- `events` hypertable (P1-004).
- Seed data (P1-005).
- Continuous aggregates (Phase 4).

## Verification

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter=@pkg/db db:migrate
pnpm --filter=@pkg/db test
```
