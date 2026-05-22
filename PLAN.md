# Implementation Plan

> Companion to [`DESIGN_DOC.md`](./DESIGN_DOC.md). The design doc is the **what** and **why**; this is the **how** and **when**. Tasks live under [`tasks/`](./tasks/) — see [`tasks/README.md`](./tasks/README.md) for the working contract.

---

## 1. Decisions locked in

These were agreed during planning and are the basis for every task below. If one changes, find the affected tasks via `tasks/INDEX.md` and update them.

| Area | Choice | Rationale (short) |
|---|---|---|
| Scope | All 5 phases sequenced; Phase 1 fully decomposed, Phase 2–5 roadmap-only until they start | Avoid premature decomposition |
| Dev environment | docker-compose locally | Single `up` from a clean clone |
| Hook binary | Bun, compiled with `bun build --compile` | Single static binary, fast cold start |
| Object store | MinIO (local dev + homelab prod) | S3-compatible, self-hostable |
| API plane | Separate Bun ingest service + Next.js UI | Different SLOs, different scaling shapes |
| DB tooling | Prisma 7 for dimensional tables; raw SQL via `prisma db execute` for Timescale hypertable + continuous aggregates | Prisma has no first-class hypertable support |
| Retention | 1 year transcripts (object store TTL), indefinite metadata | Spec §10 |
| GitHub host | Both github.com and GHES; host abstracted via `GITHUB_HOST` env | S1 may run GHES |
| Hook install | Opt-in with strong defaults | Trust per §11 |
| SSO | GitHub OAuth now; `IdentityProvider` interface seam for Okta/Azure later | Avoid coupling to GitHub identity |
| Ops handoff | Built by dev tools team; runbooks/SLOs/dashboards delivered in Phase 4 to Platform/SRE | §15 path-to-graduation |
| Existing telemetry pipelines | None — greenfield | Confirmed with user |
| PR bot | Opt-in per repo via `.claude-telemetry.yml` | §11 trust mechanic |
| Lint + format | Biome 2.x (single binary, replaces ESLint + Prettier) | One tool, faster, type-aware rules |

### Pinned tool versions (May 2026)

These are the **exact** versions every package targets. No `^` or `~` ranges in `package.json` files — see §4 "Pinning policy". Bumps happen in lockstep across the monorepo via Bun's catalog (`workspaces.catalog` in root `package.json`; see `P1-001`).

| Tool | Exact version | Why this pin |
|---|---|---|
| Node.js | 24.6.0 | Active LTS. The Next.js prod runtime is Node 24. Bun runs everything else. |
| Bun | 1.3.13 | **Package manager + workspace tool + script runner + ingest/hook runtime.** Replaces pnpm. Use HOISTED installs, not isolated — Bun 1.3.0's isolated + catalogs combo has known dedup/cache bugs ([oven-sh/bun#23615](https://github.com/oven-sh/bun/issues/23615)). Revisit when fixed. Lockfile is text `bun.lock` (v3 format). |
| Turborepo | 3.0.0 | v3 is the first release with first-class Bun workspaces support; do NOT use Turbo 2 with Bun. |
| TypeScript | 6.0.0 | TS 7 (native Go compiler) is still beta — wait. |
| Biome | 2.4.0 | v2 unified lint + format; type-aware rules + GritQL plugins. |
| Next.js | 16.2.0 | App Router default, Turbopack default for `dev` + `build`, pins React 19.2. Runs under Node 24 in prod (not Bun — Next on Bun is unofficial). |
| React | 19.2.6 | Don't drift past what Next.js 16 pins. RSC CVE fix is in this patch. |
| react-dom | 19.2.6 | Lockstep with React. |
| Tailwind CSS | 4.1.0 | Oxide engine + CSS-first config (`@theme`, no JS config file). |
| `@tailwindcss/postcss` | 4.1.0 | Lockstep with Tailwind core. |
| Prisma | 7.7.0 | Latest stable. Classic Prisma Client (not Prisma Postgres). |
| `@prisma/client` | 7.7.0 | Lockstep with `prisma`. |
| TimescaleDB image | `timescale/timescaledb-ha:pg17.9-ts2.27.0` | TSDB 2.27 on PG 17.9. Pin exact tag; TimescaleDB ABI is tied to exact PG patch. |
| MinIO image | `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` | Docker Hub MinIO images deprecated Oct 2025. Pull from quay.io. Pin exact RELEASE, never `:latest`. |
| MinIO client image | `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z` | Bucket init + lifecycle. |
| Hono | 4.12.19 | |
| `@hono/zod-validator` | 0.4.3 | Hono middleware for Zod validation. |
| Zod | 4.1.0 | v4: top-level string formats (`z.email()`, strict `z.uuid()`), `z.strictObject()/z.looseObject()` replace `.strict()/.passthrough()`. |
| jose | 6.2.3 | JWT/JWS/JWE. Zero deps, runs on Bun/Node/Workers. |
| `octokit` | 5.0.5 | GHES compatibility via `@octokit/plugin-enterprise-compatibility` if pre-3.x GHES surfaces. |
| `@octokit/plugin-enterprise-compatibility` | 4.0.1 | Conditionally loaded for old GHES. |
| `@aws-sdk/client-s3` | 3.1047.0 | MinIO via `forcePathStyle: true` + custom `endpoint`. |
| pino | 10.3.1 | Worker-thread transports. |
| `pino-pretty` | 13.1.3 | Dev-only pretty printing. |
| `pino-roll` | 4.0.0 | File rotation. |
| Croner | 10.0.1 | TS-native scheduler; replaces `node-cron` (stale, weaker DST handling). |
| Vitest | 4.1.6 | Requires Vite 8. v5 in beta — don't pin yet. |
| `fast-check` | 4.4.0 | Property-based tests in redaction package. |
| `@octokit/webhooks` | 14.1.0 | Phase 2; pin now to avoid drift. |
| `react-virtuoso` | 4.18.7 | Transcript viewer virtualization. |
| keytar | 7.9.0 | OS keychain access for the hook binary. |
| zstd | (built into Bun) | Use `Bun.zstd*` APIs; no userland package. |

---

## 2. Repo layout

Bun workspaces + Turborepo 3. Created in `P1-001`.

```
ai-agents-observability/
├── apps/
│   ├── ingest/              # Bun + Hono. POST /v1/events, /v1/transcripts, /v1/price-table
│   ├── web/                 # Next.js. Dashboard + OAuth + read API
│   ├── hook/                # Bun-compiled CLI: claude-telemetry binary
│   └── github-app/          # Phase 2. GitHub App webhook handler
├── packages/
│   ├── db/                  # Prisma schema + migrations + Timescale SQL + Prisma client export
│   ├── schemas/             # Zod schemas for hook payload, shared types
│   ├── redaction/           # Regex scrubber (imported by hook + ingest)
│   ├── github/              # Octokit wrappers, host-agnostic (github.com / GHES)
│   └── auth/                # IdentityProvider interface + GitHub impl + JWT issuance
├── infra/
│   ├── docker-compose.yml   # Postgres+Timescale, MinIO, migrations-runner
│   └── migrations-runner/   # Init container: Prisma migrate + Timescale DDL
├── tasks/                   # Per-task work units; see tasks/README.md
├── DESIGN_DOC.md
└── PLAN.md                  # This file
```

---

## 3. Phase plan

### Phase 1 — Spine + "My Agents" (target: 4–6 weeks)

**Goal**: A dev installs the hook, runs Claude Code, and sees their own usage in a web UI. No team views, no PR loop. Build trust by giving the user value before exposing data to others.

**Workstreams** (parallelizable):

| WS | Tasks | Owner-style |
|---|---|---|
| A. Data plane | P1-002, P1-003, P1-004 | Backend |
| B. Ingest API | P1-005…P1-012 | Backend |
| C. Auth | P1-013…P1-016 | Backend |
| D. Hook | P1-017…P1-021 | Systems / CLI |
| E. Web UI | P1-022…P1-027 | Frontend |
| F. Quality | P1-028, P1-029 | Cross-cutting |

**Exit criteria** (must all be green to call Phase 1 done):

- [ ] One real engineer (Jorge) runs the hook for a week; data correctness verified by spot-check.
- [ ] `/me` page loads in <500ms p50.
- [ ] Hook adds <10ms wall time to a measured tool call (microbench + real-session).
- [ ] Redaction passes the seven-class test suite (§9.1) + manual review of one real transcript.
- [ ] `claude-telemetry purge-local` cleanly removes queue + transcripts.
- [ ] `docker compose up` produces a working local stack from a clean clone.

### Phase 2 — PR Loop (target: 3–4 weeks)

GitHub App webhooks → `pull_requests` table → `session_pr_links` → `pr_rollups`. Optional PR bot comment on merge (opt-in per repo). Adds `/me/prs` page.

Roadmap-level tasks in [`tasks/P2-roadmap.md`](./tasks/P2-roadmap.md). Decompose when Phase 1 exit criteria are green.

**Exit**: PR bot comments on opt-in repos; one team lead reacts positively unprompted.

### Phase 3 — Team views (target: 3–4 weeks)

`team_lead` role middleware, `/team/[slug]` pages, audit log writes wired on every cross-user view, `/me/audit` becomes meaningful. Honors `visibility_policies`.

Roadmap-level tasks in [`tasks/P3-roadmap.md`](./tasks/P3-roadmap.md).

**Exit**: team leads use weekly; zero privacy incidents.

### Phase 4 — Org views, search, ops handoff (target: 4–6 weeks)

Org dashboards, faceted search (visibility-scoped at query layer), transcript FTS via Postgres, anomaly surfaces via Timescale continuous aggregates, **Platform/SRE handoff deliverables** (runbooks, SLOs, dashboards, on-call doc).

Roadmap-level tasks in [`tasks/P4-roadmap.md`](./tasks/P4-roadmap.md).

**Exit**: quarterly leadership readout runs off this; Platform/SRE owns the pager.

### Phase 5 — Effectiveness signals (target: ongoing)

Friction score, session-shape clustering, revert detection, optional Jira integration, optional GitHub Checks correlation.

Roadmap-level tasks in [`tasks/P5-roadmap.md`](./tasks/P5-roadmap.md).

**Exit**: at least one effectiveness signal cited in a real promo packet or planning doc.

---

## 4. Cross-cutting standards

These apply to every task. Don't restate in each task file.

- **Language**: TypeScript 6 everywhere.
- **Package manager + runner**: Bun 1.3. `bun install` for deps, `bun run <script>` for scripts, `bun --filter '@scope/pkg' <script>` for workspace-scoped runs, `bunx` instead of `pnpm dlx`/`npx`. Lockfile is `bun.lock` (text v3) — commit it.
- **Workspaces**: declared in root `package.json` `workspaces: ["apps/*", "packages/*"]`. No `pnpm-workspace.yaml`.
- **Catalogs**: centralized in root `package.json` `workspaces.catalog` (Bun's catalog syntax). Sub-packages reference shared deps as `"catalog:"`.
- **Pinning policy** (strict):
  1. **Every dependency is pinned to an exact version.** No `^`, no `~`, no `>=`, no `*`. The catalog entries in root `package.json` use bare semver (`"zod": "4.1.0"`). Sub-packages use `"catalog:"`.
  2. `bunfig.toml` sets `[install] exact = true` so `bun add` writes exact versions by default.
  3. `bun.lock` is the source of truth for what gets installed and is required to match `package.json`. CI runs `bun install --frozen-lockfile`; out-of-band edits fail the build.
  4. Docker image tags are exact (`pg17.9-ts2.27.0`, `RELEASE.2025-09-07T16-13-09Z`). Never `:latest`. SHA256-digest pinning (`@sha256:...`) acceptable for prod overlays.
  5. Engine pins: `engines.node = "24.6.0"`, `engines.bun = "1.3.13"`. CI uses these exact versions via `setup-node@v4` / `setup-bun@v2`.
  6. Bumps are deliberate: open a PR per dependency (or per coordinated group — e.g., React + react-dom + Next.js), update the catalog entry, regenerate `bun.lock`, run the full CI suite. No mass-bump PRs.
  7. Renovate/Dependabot may *propose* bumps but never auto-merges. Schedule weekly so PRs don't pile up.
  8. Security patches are an exception to (6): cherry-pick the patch version, ship same-day.
- **Runtimes**: ingest + hook run on Bun 1.3. Next.js prod runtime is Node 24 LTS (Next-on-Bun is not officially supported; revisit when it is).
- **Style**: Biome 2 at the root in `P1-001` — single binary for lint + format. No ESLint, no Prettier, no per-package overrides without justification.
- **Tests**: Vitest 4. Each `packages/*` ships with unit tests. Each app ships with at least one happy-path integration test. Coverage gates not enforced numerically — judgment-based code review.
- **Migrations**: Forward-only. Backfills written as separate migrations. Never edit a merged migration.
- **Logs**: structured JSON via `pino`. No `console.log` in committed code.
- **Secrets**: never logged, never committed. `.env.example` is the contract; real `.env` is gitignored.
- **Commits**: Conventional Commits. PR per task or per tightly-coupled task group.
- **Branching**: feature branches off `main`. Branch names follow `claude/<slug>` for AI-driven tasks and `feat/<slug>` / `fix/<slug>` for human-driven tasks.

---

## 5. Open items still gating

Tracked as **issues**, not tasks, because they need product/owner input before they become work:

1. **§13 Q4** — Cost source of truth. Default: client-computed. Reconciliation cron against Anthropic admin API deferred until ≥$10k/month spend on a team.
2. **§13 Q6** — S1's branch/PR → Jira convention. If it exists, Phase 2 rollups can ladder to feature-level for free.
3. **§13 Q8** — CI-side Claude Code runs. Doc says out-of-scope; confirming.
4. **Multi-agent extension** — `agent_type` is in the schema; Cursor adapter spike deferred to Phase 5 unless demand surfaces sooner.

---

## 6. Risks

| Risk | Mitigation | Owner-style |
|---|---|---|
| Prisma + Timescale dual-migration friction | Spike in `P1-003`; fallback to Drizzle if it bites | Backend |
| Bun-compiled binary blocked by Mac codesigning | Spike before week 3 of Phase 1 (`P1-019`) | Systems |
| MinIO in homelab = SPOF | Phase 4 ops handoff evaluates HA MinIO vs B2 fallback | Platform/SRE |
| GHES webhook payload drift | `packages/github` version-detects; integration test against a real GHES instance | Backend |
| Privacy regression on team views | Audit log is the safety net; covered by `P3-*` tasks | Cross-cutting |
| Wrong Postgres patch version breaks TimescaleDB ABI | Pin `timescale/timescaledb-ha:pg17.9-ts2.27.0` exact tag in compose; never use `:latest` | Backend |
| MinIO Docker Hub image deprecation (Oct 2025) | Pull from `quay.io/minio/minio` with pinned RELEASE tag, never `:latest` | Backend |
| Bun 1.3 isolated installs + catalogs has dedup/cache bugs ([#23615](https://github.com/oven-sh/bun/issues/23615)) | Use HOISTED installs (`linker = "hoisted"` in `bunfig.toml`) until fixed | Cross-cutting |
| Bun Rust-rewrite branch regressions on native modules | Pin Bun 1.3.13 (stable JS impl), not bleeding-edge | Systems |
| Next.js on Bun is unofficial | Run Next.js prod under Node 24; only use Bun for `apps/web` package management + script execution | Frontend |

---

## 7. How AI agents use this plan

1. Read this file end-to-end.
2. Read [`tasks/README.md`](./tasks/README.md) to understand the task contract.
3. Pick the next `status: ready` task from [`tasks/INDEX.md`](./tasks/INDEX.md) whose dependencies are all `done`.
4. Move it to `status: in-progress`, do the work, satisfy the acceptance criteria, move it to `status: done`, and update `INDEX.md`.
5. If blocked, set `status: blocked` and write the blocker in the task file.

Never start a task whose dependencies aren't `done`. Never modify a task someone else has marked `in-progress` without coordinating.
