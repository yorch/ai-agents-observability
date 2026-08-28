# ai-agents-observability

Self-hosted observability platform for AI coding agents. Captures per-event telemetry from Claude Code, opencode, Codex CLI, Gemini CLI, GitHub Copilot CLI, Pi and omp sessions, stores events in TimescaleDB, redacts transcripts before object storage, and serves personal, team, org, and admin dashboards.

## Environment files

The repository has separate templates because host-native development and production
containers need different network addresses and security defaults:

| File | Create with | Used for |
|---|---|---|
| `.env.example` → `.env` | `just dev-init` | Native app development and the Dockerized development stack |
| `.env.production.example` → `.env.production` | `just prod-init` | Production Compose with pre-built or locally-built images |

Do not use `.env` for a production deployment. In particular, its S3 and database URLs
use `localhost`, which means the host during native development but the application
container itself under Compose.

## Local development

### Prerequisites

- [Bun](https://bun.sh) 1.3.14
- [Docker](https://docs.docker.com/get-docker/) with Compose v2.30 or newer
- [just](https://just.systems/) 1.43 or newer

### Setup

```bash
bun install
just dev-init
just dev-keys
just dev-infra-up
```

Run the apps natively after the backing services start:

```bash
bun run --cwd apps/ingest dev
bun run --cwd apps/web dev
bun run --cwd apps/github-app dev  # requires the GitHub App values in .env
```

Alternatively, `just dev-up` builds and runs ingest and web in containers. Use
`just dev-pr-loop-up` to include the credential-gated GitHub App service.

The backing stack exposes PostgreSQL on `localhost:5432`, MinIO on ports `9000` and
`9001`, Prometheus on `9090`, and Grafana on `3001` by default.

### Install the hook CLI

Download the latest platform-specific `claude-telemetry` binary from GitHub Releases,
verify its checksum, and install it with the maintained installer:

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install-hook.sh | bash
```

Use `--version v1.2.0` to pin a release or `--prefix "$HOME/.local/bin"` to install
without `sudo`. Then authenticate and register the hooks:

```bash
claude-telemetry login
claude-telemetry install
```

See [`docs/deploy/hook-binary.md`](./docs/deploy/hook-binary.md) for manual downloads,
checksum verification, supported platforms, and air-gapped installation.

### Common commands

```bash
just                 # List every recipe with its description
just dev-infra-up    # Backing services for native app development
just dev-infra-logs
just dev-infra-down  # Preserves data under ./data
just dev-up          # Fully Dockerized development stack
just dev-down

bun run check
bun run typecheck
bun run build
bun run test
```

The existing `bun run docker:*` commands remain available for compatibility. The
`Justfile` is the preferred interface because each recipe selects the correct Compose
files and env file explicitly.

## Production deployment

Production setup starts from the dedicated template and pins all application images to
one release:

```bash
just prod-init
# Edit .env.production and fill every required blank value.
just prod-keys
just prod-config
just prod-up
```

Set `ENV_FILE=/path/to/env` to use another production env filename. Additional recipes
cover source builds, Traefik, and Watchtower; run `just --list` for the full matrix.
See [`docs/deploy/README.md`](./docs/deploy/README.md) for deployment details.

## Status

**Phase 1** ("My Agents" spine) — implementation complete. P1-001 through P1-028 are `done`; P1-029 (dogfood sign-off) is `ready` and requires one engineer to run the hook for five working days and record observations in `docs/phase1-*.md`.

**Phase 2** (PR loop) — implementation complete. P2-001 (GitHub App registration) is in `review`; all other P2 tasks are `done`.

**Phase 3** (team views) — code complete. P3-001 through P3-007 are `done`.

**Phases 4–6** — code complete. Org views, search, operations handoff, effectiveness signals, and hardening tasks are `done`; P6-005/P6-006 were deferred and superseded by Phase 8.

**Phases 7–9** — task work is `done`. P7-007 completed as a no-go semantic-search spike; opencode transcript upload was the one documented follow-up, closed in P12-009.

**Phase 10** (model cost optimization) — `done`. The 2026-08-18 reconciliation reopened this after an audit found `P10-002`/`P10-004`/`P10-005` unbuilt and `P10-001`/`P10-003` partial; those five are now built and the audit sections in each task file record what closed them. A shared per-agent model policy (tiers derived from the live price tables, admin-overridable at `/admin/model-policy`) replaces the hardcoded `opus` substring, savings render as **ranges**, and a `disallowed_model` alert enforces an allow-list. `P10-006` remains `cancelled` — superseded by `P13-006`, whose projection registry is what `/org/models` now records against. See [`tasks/INDEX.md`](./tasks/INDEX.md).

**Phase 11** (correlation & Jira integration) — `done`. Shipped ahead of Phase 10 as a single vertical slice: session ↔ PR ↔ repo ↔ Jira correlation, defect attribution (`/org/quality`), and significance testing on friction-band deltas.

**Phase 12** (agent adapter expansion) — `done`. Seven agents now ship data end-to-end: Claude Code, opencode, Codex, Gemini CLI, GitHub Copilot CLI, Pi and omp. Three acceptance criteria are unverified for want of the agents themselves — see [`tasks/P12-roadmap.md`](./tasks/P12-roadmap.md).

**Phase 13** (scoring & evaluation) — implemented scope `done`; four tasks `blocked` on data. Gives every computed signal provenance and a version (`scores`), separates non-human runs from the human aggregates (`run_kind`), adds content-free trajectory scorers, and captures human session labels. The validation tasks that would calibrate `friction_score` and `shape_label` against real outcomes are `blocked` on a data precondition — no rollout has happened, and calibrating against seed data measures the seed script. See [`tasks/P13-roadmap.md`](./tasks/P13-roadmap.md) and [`docs/research/2026-08-12-llm-evals-assessment.md`](./docs/research/2026-08-12-llm-evals-assessment.md); why the judge talks to Anthropic over `fetch` rather than through a provider-abstraction library is assessed in [`docs/research/2026-08-18-judge-client-provider-abstraction.md`](./docs/research/2026-08-18-judge-client-provider-abstraction.md).

See [`tasks/INDEX.md`](./tasks/INDEX.md) for task-level status — it is the source of truth, and this summary is a convenience copy.

## Architecture

See [`DESIGN_DOC.md`](./DESIGN_DOC.md) for the full architecture specification and [`PLAN.md`](./PLAN.md) for the implementation roadmap.

Reporting, scoped trends, session visuals, and exports are documented in
[`docs/reporting.md`](./docs/reporting.md). Report pages are available at `/me/report`,
`/team/[slug]/report`, and `/org/report`; trend pages are available at `/me/trends`,
`/team/[slug]/trends`, and `/org/trends`.

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
  redaction/  Transcript scrubber (9-class regex rules)
  schemas/    Zod schemas for the hook→ingest contract
infra/
  migrations-runner/       Docker image that applies all DB migrations
docs/
  github-app-setup.md      GitHub App registration guide
  reporting.md             Scoped reports, trends, session visuals, and safe exports
  design/                  UI design direction ("Instrument") + its audit
tasks/                     Agent-trackable task decomposition
```

## License

Licensed under the [Functional Source License, Version 1.1, MIT Future License](./LICENSE.md) (FSL-1.1-MIT).

You may use, copy, modify, and redistribute the software for any purpose other than a [Competing Use](./LICENSE.md#permitted-purpose). Two years after each version is released, that version becomes available to you under the [MIT License](./LICENSE.md#grant-of-future-license).
