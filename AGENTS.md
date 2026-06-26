# AI Coding Guidelines

This file provides guidance to AI Agents working **across the monorepo**. Per-app conventions live alongside the app:

- **`apps/web/`** — see [`apps/web/CLAUDE.md`](apps/web/CLAUDE.md) (authoritative for the Next 16 SPA).
- **Per-app `AGENTS.md`** files exist where they help; this root file covers cross-cutting concerns.

> `CLAUDE.md` is a symlink to `AGENTS.md` — the canonical source of truth for agent guidelines. Update either file to keep them in sync.

> **Start here:** read [`DESIGN_DOC.md`](DESIGN_DOC.md) for the project's purpose (self-hosted observability for AI coding agents — Claude Code first, with OpenCode and Codex adapters implemented), then [`PLAN.md`](PLAN.md) and [`tasks/INDEX.md`](tasks/INDEX.md) for current scope.

## Commands

This is a **bun + Turbo** monorepo. All commands run from the repo root.

```bash
# Build / lint / test / typecheck — Turbo fans out across workspaces
bun run build              # turbo run build
bun run typecheck          # turbo run typecheck
bun run test               # turbo run test
bun run check              # biome check --error-on-warnings .
bun run format             # biome format --write .

# Per-app typecheck (faster during focused work)
bun run --cwd apps/web typecheck
bun run --cwd apps/ingest typecheck

# Per-app dev (run in separate terminals)
bun run --cwd apps/web dev          # Next.js 16 (Turbopack default)
bun run --cwd apps/ingest dev       # Hono server (telemetry ingestion)
bun run --cwd apps/github-app dev   # Hono server (GitHub webhooks)
bun run --cwd apps/hook dev         # the developer-installed CLI; use during hook authoring

# Docker
bun run docker:infra:up             # Postgres-Timescale + MinIO + migrations-runner
bun run docker:infra:down           # stop (preserves volumes)
bun run docker:infra:down:v         # stop + remove volumes (DESTRUCTIVE — wipes the DB)
bun run docker:app:up               # full stack (build + run all 4 apps + infra)
bun run docker:app:down             # stop
bun run docker:app:logs             # tail logs across all services

# Hook CLI — cross-compile single-binary artifacts for distribution
bun run --cwd apps/hook build:all   # darwin-arm64 + darwin-x64 + linux-arm64 + linux-x64
```

## Pre-commit gate (MANDATORY)

**Before every `git commit`, all four gates must pass.** Do not commit if any gate fails — fix the issue first.

```bash
bun run check        # Biome lint + format (zero warnings allowed — --error-on-warnings is set)
bun run typecheck    # tsc --noEmit across all workspaces
bun run build        # ensure all packages compile
bun run test         # vitest across all workspaces
```

Run them in this order: lint → typecheck → build → test. Fix each failure before moving to the next gate. A commit that breaks any gate must not land on `main`.

## Architecture

`ai-agents-observability` ingests per-event telemetry from Claude Code on developer machines, archives full session transcripts, correlates work to GitHub PRs/teams, and exposes dashboards for three audiences: individual devs ("My Agents"), team leads, and org-level stakeholders. See [`DESIGN_DOC.md`](DESIGN_DOC.md) for the canonical scope statement.

```text
apps/
  web/          # Next.js 16 + React 19.2 + Tailwind 4 — dashboards & "My Agents" UI. See apps/web/CLAUDE.md.
  ingest/       # Hono + Bun.serve — receives telemetry events from the hook CLI; writes events to TimescaleDB + transcripts to S3 (MinIO locally).
  github-app/   # Hono + Bun.serve — GitHub webhook handler; enriches PRs into the schema.
  hook/         # Bun single-binary CLI (`claude-telemetry-<os>-<arch>`) — installed on developer machines, captures Claude Code events + transcripts, ships them to ingest.
packages/
  auth/         # auth helpers (server-side `currentUser()`, session decode). Web imports from here — DO NOT introduce NextAuth.
  db/           # Prisma 7 client + schema + raw-SQL migrations runner. Client generated to `packages/db/src/generated/client`.
  github/       # GitHub API client (octokit wrapper) — shared by web + github-app.
  redaction/    # secret-redaction pipeline (token/PII scrub) applied before transcripts hit S3.
  schemas/      # cross-package TypeScript/zod schemas for telemetry events.
infra/
  migrations-runner/  # one-shot Bun image — runs Prisma SQL migrations on stack startup, then exits. Run by docker-compose at boot.
```

### Why each service exists

| Service | Runtime | Purpose | HTTP? |
|---|---|---|---|
| `apps/web` | Bun build → Next 16 standalone | dashboards, individual "My Agents", admin | yes (HEALTHCHECK on `/health`) |
| `apps/ingest` | `Bun.serve` (Hono) | telemetry endpoint + scheduled jobs (archive rollup, S3 health check) | yes |
| `apps/github-app` | `Bun.serve` (Hono) | GitHub webhook receiver — PR enrichment | yes |
| `apps/hook` | single-binary CLI (`bun build --compile`) | runs on dev machines; **not** a server | no |
| `infra/migrations-runner` | Bun + Prisma | runs `applySqlMigrations()` once per stack boot, then exits | no (no HEALTHCHECK by design) |

### Migrations — the "runner" pattern

Unlike most workspace repos (which run `prisma migrate deploy` in each app's `docker-entrypoint.sh`), this repo uses a **dedicated `infra/migrations-runner/` one-shot container**. The runner waits for Postgres health, runs migrations via `packages/db`'s `applySqlMigrations()`, then exits with status 0. The other services depend on the runner's `condition: service_completed_successfully` in compose so they only start once the schema is current.

Why this pattern: with **4 services** all needing the same migration state, "migrate-on-boot in each service" would either race or require complex ordering. A single runner is simpler and unambiguous.

### Database (`packages/db/`)

Prisma 7 + **TimescaleDB** (custom Postgres image with hypertable extensions). Schema lives at `packages/db/prisma/schema.prisma`; generated client at `packages/db/src/generated/client` (gitignored).

Two migration layers, applied in order by the runner:
1. **Relational schema** — a single squashed Prisma migration at `packages/db/prisma/migrations/20260625075457_init/` (the project is pre-deployment, so phase migrations were merged into one Prisma-generated migration). Regenerate/verify with `prisma migrate dev` (needs the Prisma engine, which is egress-blocked in CI sandboxes — see note below).
2. **Custom SQL** — everything Prisma's DSL can't model lives in `packages/db/sql/migrations/` and is applied by `applySqlMigrations()` after `prisma migrate deploy`: TimescaleDB DDL (hypertables, continuous aggregates, retention policies) in `0001_init.sql`, and data seeds like the built-in alert rules in `0002_seed_builtin_alert_rules.sql`.

**Schema change workflow (dev):** Because Prisma uses a single squashed init migration, its idempotency check is name-based — editing `migration.sql` after it has been applied to a database will silently drift. Whenever the Prisma schema changes, reset the local database before redeploying:
```bash
bun run docker:infra:down:v   # wipes volumes
bun run docker:infra:up
bun run db:deploy
bun run db:seed               # optional
```
Do **not** work around drift by adding `ALTER TABLE` patches to `packages/db/sql/migrations/` — that layer is reserved for TimescaleDB DDL and data seeds that Prisma cannot model.

**Enum convention:** all Prisma/DB enum values are **UPPER_SNAKE_CASE** (`OrgRole.ORG_ADMIN`, `AgentType.CLAUDE_CODE`). The telemetry wire schema (`packages/schemas`) uses the same casing, so `agent_type` flows hook → ingest → DB without translation.

### Storage (`apps/ingest` + MinIO/S3)

Session transcripts are too large for the relational DB. They're streamed to S3-compatible object storage (MinIO locally, real S3 in prod), and the relational row carries the S3 key. `apps/ingest/src/index.ts` runs a `HeadBucketCommand` at boot to validate the bucket exists + credentials work — boot fails loud if not.

### Hook CLI distribution (`apps/hook/`)

The hook is the developer-facing artifact. Built with `bun build --compile --target bun-<os>-<arch>`, it ships as a **single executable** with no Node/Bun runtime required on the dev machine. The `build:all` script cross-compiles all four targets:

- `claude-telemetry-darwin-arm64` (Apple Silicon)
- `claude-telemetry-darwin-x64` (Intel Mac)
- `claude-telemetry-linux-arm64`
- `claude-telemetry-linux-x64`

The CLI installs Claude Code hooks (`commands/install`), captures events via stdin/stdout (`hook-entry`), batches them in a background flusher (`flusher`), and ships them to the configured ingest endpoint (`shipper`).

## Key conventions

- **Bun, not Node.** The runtime is Bun (Bun.serve for HTTP, bun build for compile, bun run for scripts). Don't add Node-specific build steps; don't introduce npm/yarn/pnpm to bun-only workspaces.
- **Turbo + workspace foreach.** Cross-package commands go through `turbo run …`. When adding a new app or package, add it to `turbo.json` so cache + dependency ordering work.
- **`/health`** is the canonical liveness path on web, ingest, and github-app. Public, no DB call, returns build metadata.
- **Migrations live in `packages/db/`** and apply via the `infra/migrations-runner/` container — **not** in app entrypoints. Schema-derived relational changes go through Prisma (`prisma migrate dev`); TimescaleDB DDL and data seeds Prisma can't model go in a numbered file under `packages/db/sql/migrations/`. Keep custom SQL out of the Prisma migration so it stays regenerable.
- **TimescaleDB persists to a bind mount** (`./data/postgres`), as do MinIO, Prometheus, and Grafana. The stack runs the `timescale/timescaledb` image (standard Postgres uid handling), so bind mounts are intentional and keep all stack state under `./data/` for easy backup/inspection. (The older `timescaledb-ha` image required named volumes for uid reasons; that constraint no longer applies.)
- **`apps/web` uses `@ai-agents-observability/auth`** — never introduce NextAuth. Use `currentUser()` from `apps/web/src/lib/auth.ts` in server components / route handlers (see [`apps/web/CLAUDE.md`](apps/web/CLAUDE.md) for the full conventions).
- **Redaction runs before S3 writes.** Transcripts pass through `packages/redaction` first — never write raw transcripts to MinIO/S3. New telemetry shapes that carry user-pasted content must add their own redaction rules to that package.
- **`packages/schemas` is the truth** for telemetry event shapes. The hook CLI, ingest, and web all import from there. Don't redeclare event types app-locally.
- **Service-side env validation** — each app's `loadConfig()` (Zod-validated) is the only place that touches `process.env`. Missing config is a startup failure, not a runtime crash.
- **Heavy WIP.** Later-phase features and follow-ups are tracked in `tasks/INDEX.md`; Phases 7–9 task work is `done`, with caveats documented in the task files. Check the task status before assuming a feature is fully signed off.
