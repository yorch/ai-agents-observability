# ai-agents-observability

Self-hosted observability platform for AI coding agents. Captures per-event telemetry from Claude Code sessions, stores them in TimescaleDB, redacts transcripts, and serves personal and team dashboards.

## Local development

### Prerequisites

- [Bun](https://bun.sh) 1.3.13
- [Docker](https://docs.docker.com/get-docker/) with Compose v2

### Setup

```bash
# 1. Install dependencies
bun install

# 2. Copy environment file and fill in values
cp .env.example .env

# 3. Start the data stack (Postgres + TimescaleDB + MinIO + migrations)
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

# App services (run after dev:stack)
bun --filter '@ai-agents-observability/ingest' dev   # Ingest API on :4000 (Bun, watch mode)
bun --filter '@ai-agents-observability/web' dev      # Web dashboard on :3000 (Next.js, Turbopack)

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

**Phase 1** ("My Agents" spine) — code complete. All P1 tasks are `done`. P1-029 (dogfood sign-off) is `ready`: requires one engineer to run the hook for five working days and record observations in `docs/phase1-*.md`.

**Phase 2** (PR loop) — code complete. P2-001 (GitHub App registration) needs a one-time manual registration step; P2-010 (GHES integration test) needs a GHES sandbox. All other P2 tasks are `done`.

**Phase 3** (team views) — code complete. P3-001 through P3-007 are `done`.

See [`tasks/INDEX.md`](./tasks/INDEX.md) for task-level status.

## Architecture

See [`DESIGN_DOC.md`](./DESIGN_DOC.md) for the full architecture specification and [`PLAN.md`](./PLAN.md) for the implementation roadmap.

## Project structure

```
apps/
  hook/           CLI binary — fires on every Claude Code hook event
  ingest/         Hono API — receives events from the hook
  web/            Next.js dashboard — personal + team views
  github-app/     Hono service — GitHub webhook receiver + PR bot (Phase 2)
packages/
  auth/       IdentityProvider interface + JWT issuance
  db/         Prisma schema, migrations, Timescale DDL, typed client
  github/     Octokit wrappers (github.com + GHES)
  redaction/  Transcript scrubber (7-class regex rules)
  schemas/    Zod schemas for the hook→ingest contract
infra/
  docker-compose.app.yml   Local app stack
  migrations-runner/       Docker image that applies all DB migrations
docs/
  github-app-setup.md      GitHub App registration guide
tasks/                     Agent-trackable task decomposition
```
