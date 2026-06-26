# ai-agents-observability

Self-hosted observability platform for AI coding agents. Captures per-event telemetry from Claude Code, OpenCode, and Codex CLI sessions, stores events in TimescaleDB, redacts transcripts before object storage, and serves personal, team, org, and admin dashboards.

## Local development

### Prerequisites

- [Bun](https://bun.sh) 1.3.14
- [Docker](https://docs.docker.com/get-docker/) with Compose v2

### Setup

```bash
# 1. Install dependencies
bun install

# 2. Copy environment file and fill in values
cp .env.example .env

# 3. Generate the Ed25519 JWT signing keypair (required for login)
bun run gen:keys

# 4. Start the data stack (Postgres + TimescaleDB + MinIO + migrations)
bun run docker:infra:up
```

The stack brings up:

| Service        | URL / port                                      | Purpose                          |
| -------------- | ----------------------------------------------- | -------------------------------- |
| PostgreSQL     | `localhost:5432`                                | Primary datastore (TimescaleDB)  |
| MinIO          | `localhost:9000` (API) / `localhost:9001` (UI)  | S3-compatible transcript storage |
| createbuckets  | one-shot                                        | Creates `transcripts` bucket     |
| migrations     | one-shot                                        | Applies Prisma + Timescale DDL   |

### Useful commands

```bash
bun run docker:infra:up      # Start stack in background
bun run docker:infra:logs    # Tail all service logs
bun run docker:infra:down    # Stop stack (preserves volumes)
bun run docker:infra:down:v  # Stop stack and delete volumes

# App services (run after docker:infra:up)
bun --filter '@ai-agents-observability/ingest' dev   # Ingest API on :4000 (Bun, watch mode)
bun --filter '@ai-agents-observability/web' dev      # Web dashboard on :3000 (Next.js, Turbopack)
bun --filter '@ai-agents-observability/github-app' dev # GitHub webhooks on :4001

# Hook binary
bun --filter '@ai-agents-observability/hook' dev     # Hook CLI in watch mode (for development)
bun --filter '@ai-agents-observability/hook' build   # Compile native binary → apps/hook/dist/claude-telemetry
bun --filter '@ai-agents-observability/hook' build:all  # Compile all 4 platform targets

# Database
bun --filter '@ai-agents-observability/db' db:migrate   # Run Prisma migrations
bun --filter '@ai-agents-observability/db' db:generate  # Regenerate Prisma client
bun --filter '@ai-agents-observability/db' db:studio    # Open Prisma Studio

# Quality
bun run check       # Lint + format check (Biome)
bun run format      # Auto-format
bun run typecheck   # TypeScript type check (all packages)
bun run test        # Run all tests
bun run build       # Build all packages and apps
```

### Verifying the stack

```bash
# PostgreSQL + TimescaleDB
psql "postgresql://postgres:postgres@localhost:5432/ai_agents_observability" \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';"

# MinIO
curl -sf http://localhost:9000/minio/health/live && echo "MinIO OK"
```

## Status

**Phase 1** ("My Agents" spine) — implementation complete. P1-001 through P1-028 are `done`; P1-029 (dogfood sign-off) is `ready` and requires one engineer to run the hook for five working days and record observations in `docs/phase1-*.md`.

**Phase 2** (PR loop) — implementation complete. P2-001 (GitHub App registration) and P2-010 (GHES integration test) are in `review`; all other P2 tasks are `done`.

**Phase 3** (team views) — code complete. P3-001 through P3-007 are `done`.

**Phases 4–6** — code complete. Org views, search, operations handoff, effectiveness signals, and hardening tasks are `done`; P6-005/P6-006 were deferred and superseded by Phase 8.

**Phases 7–9** — task work is `done`. P7-007 completed as a no-go semantic-search spike; opencode transcript upload and SMTP email delivery remain documented follow-ups.

See [`tasks/INDEX.md`](./tasks/INDEX.md) for task-level status.

## Architecture

See [`DESIGN_DOC.md`](./DESIGN_DOC.md) for the full architecture specification and [`PLAN.md`](./PLAN.md) for the implementation roadmap.

## Project structure

```
apps/
  hook/           CLI binary — captures supported agent events and transcripts
  ingest/         Hono API — receives events from the hook
  web/            Next.js dashboard — personal, team, org, and admin views
  github-app/     Hono service — GitHub webhook receiver + PR bot
packages/
  auth/       IdentityProvider interface + JWT issuance
  db/         Prisma schema, migrations, Timescale DDL, typed client
  github/     Octokit wrappers (github.com + GHES)
  redaction/  Transcript scrubber (7-class regex rules)
  schemas/    Zod schemas for the hook→ingest contract
infra/
  migrations-runner/       Docker image that applies all DB migrations
docs/
  github-app-setup.md      GitHub App registration guide
tasks/                     Agent-trackable task decomposition
```

## License

Licensed under the [Functional Source License, Version 1.1, MIT Future License](./LICENSE.md) (FSL-1.1-MIT).

You may use, copy, modify, and redistribute the software for any purpose other than a [Competing Use](./LICENSE.md#permitted-purpose). Two years after each version is released, that version becomes available to you under the [MIT License](./LICENSE.md#grant-of-future-license).
