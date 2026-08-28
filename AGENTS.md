# AI Coding Guidelines

This file provides guidance to AI Agents working **across the monorepo**. Per-app conventions live alongside the app:

| Directory | File | Covers |
|---|---|---|
| `apps/web/` | [`AGENTS.md`](apps/web/AGENTS.md) | tokens, UI primitives, chart grammar, routing (authoritative for the Next 16 SPA) |
| `apps/hook/` | [`AGENTS.md`](apps/hook/AGENTS.md) | adapter seam, the always-exit-0 rule, the perf budget, cross-compile |
| `apps/ingest/` | [`AGENTS.md`](apps/ingest/AGENTS.md) | routes, double redaction, cost recompute, the scheduled jobs |
| `packages/db/` | [`AGENTS.md`](packages/db/AGENTS.md) | the two migration layers and the squashed-migration drift trap |

Those files **load only when an agent touches that directory**, so detail there is free; detail here is paid for in every session. This root file therefore covers cross-cutting concerns only. Put a new rule in the narrowest file it applies to, and add a per-directory `AGENTS.md` when a workspace's conventions genuinely differ.

> **Convention:** in every directory that has both, `AGENTS.md` is the real file and `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`. Claude Code reads `CLAUDE.md`; other agents read `AGENTS.md`; the symlink means one file serves both.
>
> **Nested files add, they don't override.** Claude Code concatenates this file with the per-directory one. Other agents may load only the *nearest* file ([the AGENTS.md spec says "the closest one takes precedence"](https://agents.md/) and leaves merge behaviour unspecified), so each per-directory file restates the two or three invariants that would be dangerous to lose. Never write a rule in a nested file that *contradicts* this one — that resolves differently depending on which agent is reading.

> **Start here:** read [`DESIGN_DOC.md`](DESIGN_DOC.md) for the project's purpose (self-hosted observability for AI coding agents — Claude Code first, with adapters for opencode, Codex, Gemini CLI, Copilot CLI, Pi and omp), then [`PLAN.md`](PLAN.md) and [`tasks/INDEX.md`](tasks/INDEX.md) for current scope.

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

# Docker (Justfile is the preferred interface; run `just` to list all recipes)
just dev-infra-up                   # backing services for native app development
just dev-up                         # fully Dockerized development stack
just prod-config                    # validate production configuration
just prod-up                        # production with pre-built images
just prod-source-up                 # production built from source
bun run docker:infra:down:v         # DESTRUCTIVE — wipes the DB; no Just recipe by design

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

**CI is weaker than this gate — that is deliberate, and it is on you.** `.github/workflows/ci.yml` runs typecheck, lint, and test, but **not `bun run build`**. A build break passes CI. Run all four locally.

**One idiom for workspace commands.** Use `bun run --cwd <path> <script>` (e.g. `bun run --cwd apps/web typecheck`). `bun --filter '@ai-agents-observability/web' <script>` also works and appears in `README.md`; prefer `--cwd` in new docs and scripts so there is one form to learn.

## Architecture

`ai-agents-observability` ingests per-event telemetry from AI coding agents on developer machines (seven have working adapters: Claude Code, opencode, Codex, Gemini CLI, Copilot CLI, Pi and omp), archives full session transcripts, correlates work to GitHub PRs/teams, and exposes dashboards for three audiences: individual devs ("My Agents"), team leads, and org-level stakeholders. See [`DESIGN_DOC.md`](DESIGN_DOC.md) for the canonical scope statement.

**Agent-neutrality is a live constraint, not an aspiration.** New capabilities branch on `agent_type`, use the `<agent>:<tool>` naming convention, and drive user-facing copy from the agent label. Don't write "Claude Code" into a user-facing string or a schema field that any agent flows through.

| Workspace | Runtime | Purpose | HTTP? |
|---|---|---|---|
| `apps/web` | Bun build → Next 16 standalone | dashboards, "My Agents", admin | yes |
| `apps/ingest` | `Bun.serve` (Hono) | telemetry intake + scheduled jobs | yes |
| `apps/github-app` | `Bun.serve` (Hono) | GitHub webhook receiver — PR enrichment | yes |
| `apps/hook` | single-binary CLI (`bun build --compile`) | runs on dev machines; **not** a server | no |
| `infra/migrations-runner` | Bun + Prisma | `applySqlMigrations()` once per stack boot, then exits | no, by design |
| `packages/auth` | — | `currentUser()`, session decode, JWT issuance. **Not NextAuth** | — |
| `packages/db` | — | Prisma 7 client + schema + SQL migration runner | — |
| `packages/github` | — | Octokit wrapper — shared by web + github-app | — |
| `packages/redaction` | — | secret/PII scrub, applied before transcripts hit S3 | — |
| `packages/schemas` | — | the zod wire contract for telemetry events, plus the pure definitions more than one workspace must agree on | — |

### Migrations — the "runner" pattern

Unlike most workspace repos (which migrate from each app's `docker-entrypoint.sh`), a **dedicated `infra/migrations-runner/` one-shot container** runs them once and exits 0; every service gates on its `condition: service_completed_successfully`. With four services needing the same schema state, migrate-on-boot in each would race or need careful ordering.

**Before you change `schema.prisma`, read [`packages/db/AGENTS.md`](packages/db/AGENTS.md)** — the squashed init migration drifts silently if you patch it, and the recovery is a database reset.

## Key conventions

- **Bun, not Node.** The runtime is Bun (Bun.serve for HTTP, bun build for compile, bun run for scripts). Don't add Node-specific build steps; don't introduce npm/yarn/pnpm to bun-only workspaces.
- **Turbo + workspace foreach.** Cross-package commands go through `turbo run …`. When adding a new app or package, add it to `turbo.json` so cache + dependency ordering work.
- **`/health`** is the canonical liveness path on web, ingest, and github-app. Public, no DB call, returns build metadata.
- **Migrations live in `packages/db/`** and apply via the `infra/migrations-runner/` container — **not** in app entrypoints. Relational changes go through Prisma; what Prisma can't model goes in a numbered file under `packages/db/sql/migrations/`. Details and the drift trap: [`packages/db/AGENTS.md`](packages/db/AGENTS.md).
- **TimescaleDB persists to a bind mount** (`./data/postgres`), as do MinIO, Prometheus, and Grafana. The stack runs the `timescale/timescaledb` image (standard Postgres uid handling), so bind mounts are intentional and keep all stack state under `./data/` for easy backup/inspection. (The older `timescaledb-ha` image required named volumes for uid reasons; that constraint no longer applies.)
- **`apps/web` uses `@ai-agents-observability/auth`** — never introduce NextAuth. Use `currentUser()` from `apps/web/src/lib/auth.ts` in server components / route handlers (see [`apps/web/AGENTS.md`](apps/web/AGENTS.md) for the full conventions).
- **Redaction runs before S3 writes.** Transcripts pass through `packages/redaction` first — never write raw transcripts to MinIO/S3. New telemetry shapes that carry user-pasted content must add their own redaction rules to that package.
- **`packages/schemas` is the truth** for telemetry event shapes. The hook CLI, ingest, and web all import from there. Don't redeclare event types app-locally.
- **A definition two workspaces must agree on lives in `packages/schemas`, not in whichever one wrote it first.** `toolCategory()` (P14-002), the cost-attribution arithmetic (P14-011), `judgeCostUsd`, `estimateRoutingSavings` and the trajectory scorers are all there because a second caller — usually `packages/db/src/seed.ts`, which cannot depend on an app — would otherwise reimplement them. A seed that recomputes production's arithmetic is how a fabricated number survives review: every query gets written against it and agrees with it. Adding a caller is the fix; retyping the definition is the bug.
- **Service-side env validation** — each app's `loadConfig()` (Zod-validated) is the only place that touches `process.env`. Missing config is a startup failure, not a runtime crash.
- **Check task status before assuming a feature is signed off.** [`tasks/INDEX.md`](tasks/INDEX.md) is the source of truth for what is `done` vs `ready` vs `review` — the roadmap prose in `README.md` / `PLAN.md` is a convenience copy and has drifted before. Caveats live in the individual task files.
