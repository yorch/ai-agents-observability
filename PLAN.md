# Implementation Plan

> Companion to [`DESIGN_DOC.md`](./DESIGN_DOC.md). The design doc is the **what** and **why**; this is the **how** and **when**. Tasks live under [`tasks/`](./tasks/) — see [`tasks/README.md`](./tasks/README.md) for the working contract.

---

## 1. Decisions locked in

These were agreed during planning and are the basis for every task below. If one changes, find the affected tasks via `tasks/INDEX.md` and update them.

| Area | Choice | Rationale (short) |
|---|---|---|
| Scope | Phases 1–9 sequenced and done, plus Phase 11 (shipped out of order as one vertical slice) and Phase 12 (agent adapter expansion, done); Phase 10 partly shipped and reconciled per task (two `in-progress`, three `ready`, one `cancelled`); Phase 13 (scoring & evaluation) done except four tasks `blocked` on the DP-1 data precondition; remaining open statuses are operational sign-off / integration items in P1–P2 plus P6 deferrals superseded by P8 | Keep the plan aligned with task status |
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
| PR bot | Opt-in per repo via `.aiot.yml` | §11 trust mechanic |
| Lint + format | Biome 2.x (single binary, replaces ESLint + Prettier) | One tool, faster, type-aware rules |

### Pinned tool versions (July 2026)

These are the versions every package targets. No `^` or `~` ranges in `package.json` files — see §4 "Pinning policy". Bumps happen in lockstep across the monorepo via Bun's catalog (`workspaces.catalog` in root `package.json`; see `P1-001`). Docker images should be pinned before production use; the current local TimescaleDB image is the one known exception and is tracked as a hardening risk below.

New pins are only taken once they clear `bunfig.toml`'s `minimumReleaseAge` (5-day) supply-chain guard, so this table can lag `latest` by a few days by design — see the two exceptions called out below.

| Tool | Exact version | Why this pin |
|---|---|---|
| Node.js | >=24 | Active LTS. The Next.js prod runtime is Node 24. Bun runs everything else. `package.json` uses `"node": ">=24"`; CI uses `actions/setup-node@v7` reading `.node-version` (major pin, not exact patch). |
| Bun | 1.3.14 | **Package manager + workspace tool + script runner + ingest/hook runtime.** Replaces pnpm. Use HOISTED installs, not isolated — Bun 1.3.0's isolated + catalogs combo has known dedup/cache bugs ([oven-sh/bun#23615](https://github.com/oven-sh/bun/issues/23615)). Revisit when fixed. Lockfile is text `bun.lock` (v3 format). |
| Turborepo | 2.10.9 | Works correctly with Bun workspaces in practice. Upgrade to 3.x when it stabilises. |
| TypeScript | 7.0.2 | The native Go ("tsgo") compiler. Adopted across every workspace; `tsc --noEmit` is the typecheck gate and `apps/web` typechecks clean against Next.js 16.3. |
| Biome | 2.5.8 | v2 unified lint + format; type-aware rules + GritQL plugins. `linter.rules.recommended` migrated to `preset` (`recommended` deprecated in 2.5). |
| Next.js | 16.3.1 | App Router default, Turbopack default for `dev` + `build`, pins React 19.2. Runs under Node 24 in prod (not Bun — Next on Bun is unofficial). 16.3 adds the Turbopack filesystem build cache and native Node streams for SSR; no app-code migration was required. |
| React | 19.2.8 | Don't drift past what Next.js 16 pins. |
| react-dom | 19.2.8 | Lockstep with React. |
| Tailwind CSS | 4.3.3 | Oxide engine + CSS-first config (`@theme`, no JS config file). |
| `@tailwindcss/postcss` | 4.3.3 | Lockstep with Tailwind core. |
| Prisma | 7.9.1 | Latest stable. Classic Prisma Client (not Prisma Postgres). |
| `@prisma/client` | 7.9.1 | Lockstep with `prisma`. |
| TimescaleDB image | `timescale/timescaledb:latest-pg18` | Current local-dev compose image. This intentionally uses the standard TimescaleDB image with bind-mounted state under `./data/postgres`; revisit exact tag pinning before production hardening. |
| MinIO image | `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` | Docker Hub MinIO images deprecated Oct 2025. Pull from quay.io. Pin exact RELEASE, never `:latest`. |
| MinIO client image | `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z` | Bucket init + lifecycle. |
| Prometheus image | `prom/prometheus:v3.14.0` | Scrapes `/metrics` on web, ingest and github-app. `infra/prometheus/prometheus.yml` validates clean under `promtool check config` on this tag. |
| Grafana image | `grafana/grafana:13.2.0` | Dashboards + datasource are file-provisioned from `infra/grafana/`. The 12→13 jump migrates the Grafana sqlite DB under `./data/grafana` **forward only** — snapshot that directory before upgrading a live install, because Grafana does not support downgrading it. |
| Watchtower image | `ghcr.io/nicholas-fedor/watchtower:1.21.0` | Optional auto-update overlay. `containrrr/watchtower` was archived Dec 2025; this maintained fork keeps the `com.centurylinklabs.watchtower.*` label namespace and the `WATCHTOWER_*` variables, so the compose overlay is unchanged apart from the image. |
| Hono | 4.13.2 | HTTP framework for `apps/ingest` + `apps/github-app`, served by `Bun.serve`. |
| `@hono/zod-validator` | 0.9.0 | Hono middleware for Zod validation; first version with real Zod v4 peer support. |
| Zod | 4.4.3 | v4: top-level string formats (`z.email()`, strict `z.uuid()`), `z.strictObject()/z.looseObject()` replace `.strict()/.passthrough()`. |
| jose | 6.2.8 | JWT/JWS/JWE. Zero deps, runs on Bun/Node/Workers. |
| `octokit` | 5.0.5 | GHES compatibility via `@octokit/plugin-enterprise-compatibility` if pre-3.x GHES surfaces. |
| `@octokit/plugin-enterprise-compatibility` | 6.0.3 | Conditionally loaded for old GHES. ESM-only since v5 — fine, this repo only uses `import`. |
| `@aws-sdk/client-s3` | 3.1110.0 | MinIO via `forcePathStyle: true` + custom `endpoint`. |
| pino | 10.3.1 | Worker-thread transports. |
| `pino-pretty` | 13.1.3 | Dev-only pretty printing. |
| nodemailer | 9.0.5 | Alert email delivery from `apps/ingest`. 9.0.4/9.0.5 are MIME + header injection hardening. |
| `@types/nodemailer` | 8.0.1 | Types for the above. |
| `prom-client` | 15.1.3 | `/metrics` exposition on web, ingest and github-app. |
| Croner | 10.0.1 | Catalog dependency reserved for scheduler work; current ingest scheduling is implemented with in-process intervals plus `job_config`. |
| Vitest | 4.1.10 | Requires Vite 8. v5 in beta — don't pin yet. |
| `fast-check` | 4.9.0 | Property-based tests in redaction package. |
| `@octokit/webhooks` | 14.2.0 | Phase 2; pin now to avoid drift. |
| `react-virtuoso` | 4.18.11 | Transcript viewer virtualization. |
| keytar | 7.9.0 | OS keychain access for the hook binary. |
| js-yaml | 5.3.0 | Ships its own types (`@types/js-yaml` removed). |
| `@faker-js/faker` | 10.5.0 | Seed script fake data. |
| zstd | (built into Bun) | Use `Bun.zstd*` APIs; no userland package. |

---

## 2. Repo layout

Bun workspaces + Turborepo (see §1's pinned-versions table for the current exact version). Created in `P1-001`.

```
ai-agents-observability/
├── apps/
│   ├── ingest/              # Bun + Hono. POST /v1/events, /v1/transcripts, /v1/price-table
│   ├── web/                 # Next.js. Dashboard + OAuth + read API
│   ├── hook/                # Bun-compiled CLI: aiot binary
│   └── github-app/          # Phase 2. GitHub App webhook handler
├── packages/
│   ├── db/                  # Prisma schema + migrations + Timescale SQL + Prisma client export
│   ├── schemas/             # Zod schemas for hook payload, shared types
│   ├── redaction/           # Regex scrubber (imported by hook + ingest)
│   ├── github/              # Octokit wrappers, host-agnostic (github.com / GHES)
│   └── auth/                # IdentityProvider interface + GitHub impl + JWT issuance
├── infra/
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
- [ ] Redaction passes the class test suite (§9.1 — seven classes at Phase 1; nine today, after `git-remote-url` and `email` landed) + manual review of one real transcript.
- [ ] `aiot purge-local` cleanly removes queue + transcripts.
- [ ] `docker compose up` produces a working local stack from a clean clone.

### Phase 2 — PR Loop (target: 3–4 weeks)

GitHub App webhooks → `pull_requests` table → `session_pr_links` → `pr_rollups`. Optional PR bot comment on merge (opt-in per repo). Adds `/me/prs` page.

Tasks P2-001–P2-010 are fully decomposed and implemented. See [`tasks/INDEX.md`](./tasks/INDEX.md) for current status. P2-001 (GitHub App credentials wiring) and P2-010 (GHES integration test) remain in review; all other P2 tasks are done.

**Exit**: PR bot comments on opt-in repos; one team lead reacts positively unprompted.

### Phase 3 — Team views (target: 3–4 weeks)

`team_lead` role middleware, `/team/[slug]` pages, audit log writes wired on every cross-user view, `/me/audit` becomes meaningful. Honors `visibility_policies`.

Tasks P3-001–P3-007 are fully decomposed and implemented (all `done`). See [`tasks/INDEX.md`](./tasks/INDEX.md).

*Post-P3 dashboard improvements (2026-06-25):* date range selector (7d/30d/90d), period-over-period delta indicators on stat cards, team PR rollup tab (`/team/[slug]/prs`), cache efficiency metric. These additions extend the existing team views without new task files; see `DESIGN_DOC.md §12.3`.

**Exit**: team leads use weekly; zero privacy incidents.

### Phase 4 — Org views, search, ops handoff (target: 4–6 weeks)

Org dashboards, faceted search (visibility-scoped at query layer), transcript FTS via Postgres, anomaly surfaces via Timescale continuous aggregates, **Platform/SRE handoff deliverables** (runbooks, SLOs, dashboards, on-call doc).

Tasks P4-001–P4-011 are fully decomposed and implemented (all `done`). See [`tasks/INDEX.md`](./tasks/INDEX.md).

*Post-P4 dashboard improvements (2026-06-25):* date range selector and period deltas mirrored from the team dashboard; org adoption funnel widget; per-team model governance table (org admin only). See `DESIGN_DOC.md §12.4`.

**Exit**: quarterly leadership readout runs off this; Platform/SRE owns the pager.

### Phase 5 — Effectiveness signals (target: ongoing)

Friction score, session-shape clustering, revert detection, optional Jira integration, optional GitHub Checks correlation.

Tasks P5-001–P5-006 are fully decomposed and implemented (all `done`). See [`tasks/INDEX.md`](./tasks/INDEX.md).

**Exit**: at least one effectiveness signal cited in a real promo packet or planning doc.

### Phase 6 — Hardening & scale-readiness

Data-integrity, observability, and access-model fixes for the platform as it exists, deliberately *not* building multi-instance/multi-agent machinery the v1 scope doesn't need. P6-001–P6-004 are `done`; P6-005 (per-agent price tables) and P6-006 (hook adapter seam) were deferred and are now decomposed under Phase 8. See [`tasks/P6-roadmap.md`](./tasks/P6-roadmap.md).

---

Phases 7–9 were raised from a post-Phase-6 gap assessment (the platform spine is complete; these close the gap between *captured* and *surfaced*, prove the multi-agent spine, and add proactive/governed operation). They are decomposed into task files and now marked `done`; see [`tasks/INDEX.md`](./tasks/INDEX.md) for exact task status. The §8.4 governance work was reconciled with the org transcript-access routes added in parallel on `main`.

### Phase 7 — Insight Surfaces & Search

Surface the effectiveness signals that are already computed but rendered nowhere (`friction_score`, `shape_label`) across `/me`, team, and org views; give every dev full-text search over their **own** transcripts (today FTS is org-only); enrich faceted search with shape / friction / agent facets. A gated pgvector semantic-search spike is included but explicitly not a production commitment. Honors `DESIGN_DOC.md` §10.3 / §10.6 (surface-later + the effectiveness caveat — never show a misleading number for low-data sessions).

Tasks P7-001–P7-007 are `done`. P7-007 completed as a no-go semantic-search spike: keyword FTS remains the production path until overlap data proves a material recall gap and a self-hosted embedding path exists.

**Exit**: a dev sees their friction trend + shape mix on `/me`; a team lead sees a team friction distribution that honors visibility policies; a dev can search their own transcripts.

### Phase 8 — Multi-Agent & Cost Model

Build the remaining multi-agent foundation and validate it with a real second adapter. Implements the `<agent>:<tool>` collision-avoidance convention (`DESIGN_DOC.md` §2.4) that was documented but never built; per-agent + versioned price tables (the deferred P6-005); a hook adapter seam extracted from **two** real examples (the deferred P6-006), with `opencode` as the validating second agent; and agent-driven user-facing copy. Cost reconciliation against a vendor billing API is scaffolded behind a flag (gated per `DESIGN_DOC.md` §13 Q4).

Tasks P8-001–P8-007 are `done`. opencode transcript upload was a follow-up here — opencode history is directory-shaped, and the shipper reads a single file — closed in Phase 12 (P12-009) by collating a directory target into one JSONL before shipping.

**Exit**: a second agent's sessions ingest, price correctly, render with the right labels, and never collide on tool names; the hook transport is shared between two adapters without forking.

### Phase 9 — Alerting & Governance

Turn render-time anomaly detection into a scheduled alert-evaluation job with persisted history and channel delivery (email / Slack / webhook); make privileged transcript access **time-boxed, requested, approved, and audited** (builds the §8.4 investigation path the audit actions already imply); add per-team retention overrides; and add a narrow, grant-scoped research/investigator capability for the Audience-B persona with **no standing access**. Real-time alerting was a v1 non-goal (`DESIGN_DOC.md` §2.2) now deliberately scoped for a later phase. Trust guardrails are first-class: alerts carry no individual-identifying data; every grant and view is auditable and expiring.

Tasks P9-001–P9-006 are `done`. The alert engine evaluates all six rule types — spend-spike, error-rate, unknown-model surge, autonomy surge, budget threshold and routing waste. The last two are seeded disabled: each needs an operator-chosen threshold before it means anything, and `parseBudgetThresholdParams` keeps a misconfigured budget rule silent rather than firing. Slack, generic webhook, and SMTP email delivery are all live — the email channel wires up only when `SMTP_HOST` and `SMTP_FROM` are configured (`apps/ingest/src/lib/notify/email.ts`).

**Exit**: a spend spike fires a notification within one evaluation cycle; every privileged transcript view is the owner or a time-boxed approved grant, logged and visible to the viewed user; zero standing individual access beyond org_admin.

### Phase 11 — Correlation & Jira Integration

Shipped **ahead of Phase 10**, as a single vertical slice rather than a phased build: commit-SHA and open-PR link backfill, `pull_request_review` / `check_run` / `push` webhook capture, session-level Jira keys, the env-gated Jira issue sync (`JIRA_VALUE_FIELD` → `jira_issues.business_value`), and the ROI / delivery / quality surfaces built on top.

Tasks P11-001–P11-004 are `done`, including defect attribution (`/org/quality`) and Fisher's-exact significance testing on friction-band deltas.

**Exit**: met — a session traces to its PR, its checks, its reviews, and its Jira issue, and `/org/roi` prices delivery against real business value rather than a flat proxy.

### Phase 10 — Model Cost Optimization

**Partly shipped, reconciled 2026-08-18.** Turns the heuristic `/org/models` routing card into a defensible, governed, persona-appropriate optimization capability grounded in the per-agent price tables. Ranked #1 by impact-to-effort in [`OPPORTUNITIES.md`](./OPPORTUNITIES.md) §4.

The phase never ran as a phase; parts of it arrived through P8/P11 work, which is why `INDEX.md` and the task files disagreed for a while. Audited against the code and settled per task on 2026-08-18, then **closed on 2026-08-20**: `P10-001` through `P10-005` are `done`, and `P10-006` stays `cancelled`, superseded by `P13-006`.

What closed it was building the load-bearing gap the audit named. "Premium" had been the literal substring `opus`, written twice — a constant in `apps/web` and an `ILIKE '%opus%'` in an `apps/ingest` raw query — which was wrong twice over: it silently matched nothing for the six non-Anthropic agents, and two copies of a policy drift. [`packages/schemas/src/model-policy.ts`](./packages/schemas/src/model-policy.ts) now holds one definition that both apps read, exactly as they already share the alert thresholds. Tiers are **derived** by ranking distinct blended rates inside each agent's own price table — the cheapest-to-dearest spread is ~19x for `claude_code` but ~8000x for the models.dev-generated tables, so no single multiple serves both — then overlaid with admin overrides from a `model_policy` table edited at `/admin/model-policy`.

The audit's open design question is settled toward honesty: a model the price table cannot price yields **no recommendation**, rather than a flat `HAIKU_SAVINGS_RATIO` fallback marked imprecise, and those models are surfaced explicitly as unpriced. Savings are ranges. Governance landed as `disallowed_model`, reading the same policy, seeded disabled, where an empty allow-list means *unconfigured* and never *deny everything*.

**Exit**: a routing recommendation carries a savings figure an engineer can defend from the price table, and a team can see its own routing accountability without an org admin reading anyone's sessions.

### Phase 12 — Agent Adapter Expansion

Takes the P8 seam from three agents to **seven**. Codex moves onto its native lifecycle hooks (the rollout file is still read, but only for token usage, which the hook payload omits); Gemini CLI and GitHub Copilot CLI join as configuration objects over a shared `createStdinHookAdapter` factory, because those three agents converged on Claude Code's stdin hook shape; Pi and omp join as in-process extensions, sharing one implementation since omp is a Pi fork.

Tasks P12-001–P12-012 are `done`. Along the way it fixed a silent drop of every live opencode event (their `ses_`-prefixed session ids failed `EventSchema`'s UUID requirement, and ingest drops invalid events per event), and a transcript-idempotency bug that had frozen **every** agent's transcript at its first upload. P12-010 then filled the price tables the new adapters shipped empty, corrected two stale ones (Opus 4.6/4.7 were priced at the retired 4.1 rate; Codex stopped at the GPT-4o era), and fixed the token accounting behind them — OpenAI and Google report one inclusive prompt total with the cached tokens *inside* it, so passing that through billed cached tokens twice. P12-011 then made those corrections retroactive — an operator-triggered `reprice-events` job that recomputes stored `events.cost_usd` from the token counts on each row and carries the change through session totals, PR rollups and the cost continuous aggregates — and put the models nothing prices on `/admin/price-tables` instead of only in a Prometheus counter — which immediately showed how thin the provider-agnostic tables were, so P12-012 generates those three from the models.dev catalog the agents themselves use for model IDs (34 models across 3 vendors → 243 across 20). Three acceptance criteria remain unverified for want of the agents themselves — see [`tasks/P12-roadmap.md`](./tasks/P12-roadmap.md).

**Exit**: met — seven agents ship data end-to-end, an agent whose session id is not a UUID ingests correctly, the four stdin-hook adapters share one implementation, and opencode's directory-shaped history uploads via an agent-neutral collation in the shipper.

### Phase 13 — Scoring & Evaluation

**In progress.** Gives every computed signal provenance and a version, adds scorers that need no transcript access, captures human labels, and — once real data exists — validates the heuristics that already ship (`friction_score`, `shape_label`) against real engineering outcomes. Decomposed from [`docs/research/2026-08-12-llm-evals-assessment.md`](./docs/research/2026-08-12-llm-evals-assessment.md) after the owner scoped `DESIGN_DOC.md` §2.2's "prompt evaluation" non-goal to *model/agent benchmarking* only.

Sequenced against the fact that no rollout has happened: build only what pays off regardless of whether one does, and prefer what gets more expensive with time. The analysis tasks are `blocked` on a stated data precondition (DP-1) and unblock themselves when a corpus arrives. See [`tasks/P13-roadmap.md`](./tasks/P13-roadmap.md).

**Exit**: no number on a dashboard is asserted without provenance, a version, and — once measurable — a published relationship to a real outcome. No individual's score is visible to anyone but them.

**Overlaps Phase 10.** P13-006 implements the projected-vs-realized check that P10-006 specifies, as a general mechanism — a projection registry rather than a routing-specific panel. `P10-006` is now `cancelled` as superseded, settled by owner decision on 2026-08-18 with the rest of the Phase 10 reconciliation; the criterion-by-criterion mapping is in that task file.

---

## 4. Cross-cutting standards

These apply to every task. Don't restate in each task file.

- **Language**: TypeScript 7 everywhere (the native `tsgo` compiler).
- **Package manager + runner**: Bun 1.3. `bun install` for deps, `bun run <script>` for scripts, `bun --filter '@scope/pkg' <script>` for workspace-scoped runs, `bunx` instead of `pnpm dlx`/`npx`. Lockfile is `bun.lock` (text v3) — commit it.
- **Workspaces**: declared in root `package.json` `workspaces: ["apps/*", "packages/*"]`. No `pnpm-workspace.yaml`.
- **Catalogs**: centralized in root `package.json` `workspaces.catalog` (Bun's catalog syntax). Sub-packages reference shared deps as `"catalog:"`.
- **Pinning policy** (strict):
  1. **Every dependency is pinned to an exact version.** No `^`, no `~`, no `>=`, no `*`. The catalog entries in root `package.json` use bare semver (`"zod": "4.4.3"`). Sub-packages use `"catalog:"`.
  2. `bunfig.toml` sets `[install] exact = true` so `bun add` writes exact versions by default.
  3. `bun.lock` is the source of truth for what gets installed and is required to match `package.json`. CI runs `bun install --frozen-lockfile`; out-of-band edits fail the build.
  4. Docker image tags should be exact before production use. MinIO is already pinned (`RELEASE.2025-09-07T16-13-09Z`); the local TimescaleDB image currently uses `timescale/timescaledb:latest-pg18` and is called out as a hardening risk in §6. SHA256-digest pinning (`@sha256:...`) is acceptable for prod overlays.
  5. Engine pins: `engines.node = ">=24"` in `package.json`; CI uses `actions/setup-node@v7` reading `.node-version` (major pin). `engines.bun = "1.3.14"` exact; CI uses `oven-sh/setup-bun@v2.2.0` with `bun-version: '1.3.14'` (exact).
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
4. **Multi-agent extension** — `agent_type` is in the schema; seven adapters ship (Claude Code, opencode, Codex, Gemini CLI, Copilot CLI, Pi, omp). Cursor, Aider and Windsurf remain schema entries without adapters.

---

## 6. Risks

| Risk | Mitigation | Owner-style |
|---|---|---|
| Prisma + Timescale dual-migration friction | Spike in `P1-003`; fallback to Drizzle if it bites | Backend |
| Bun-compiled binary blocked by Mac codesigning | Spike before week 3 of Phase 1 (`P1-019`) | Systems |
| MinIO in homelab = SPOF | Phase 4 ops handoff evaluates HA MinIO vs B2 fallback | Platform/SRE |
| GHES webhook payload drift | `packages/github` version-detects; integration test against a real GHES instance | Backend |
| Privacy regression on team views | Audit log is the safety net; covered by `P3-*` tasks | Cross-cutting |
| Wrong Postgres patch version breaks TimescaleDB ABI | Local dev currently uses `timescale/timescaledb:latest-pg18`; pin an exact `timescale/timescaledb` tag before production hardening. | Backend |
| MinIO Docker Hub image deprecation (Oct 2025) | Pull from `quay.io/minio/minio` with pinned RELEASE tag, never `:latest` | Backend |
| Bun 1.3 isolated installs + catalogs has dedup/cache bugs ([#23615](https://github.com/oven-sh/bun/issues/23615)) | Use HOISTED installs (`linker = "hoisted"` in `bunfig.toml`) until fixed | Cross-cutting |
| Watchtower is a third-party fork with `docker.sock` access | The upstream `containrrr/watchtower` is archived; `nickfedor/watchtower` is pinned to an exact tag (never `:latest`) and the overlay stays opt-in — it is not part of `docker:app` or `docker:infra`. Re-audit the fork before enabling it in production. | Platform/SRE |
| Bun Rust-rewrite branch regressions on native modules | Pin Bun 1.3.14 (stable JS impl), not bleeding-edge | Systems |
| Next.js on Bun is unofficial | Run Next.js prod under Node 24; only use Bun for `apps/web` package management + script execution | Frontend |

---

## 7. How AI agents use this plan

1. Read this file end-to-end.
2. Read [`tasks/README.md`](./tasks/README.md) to understand the task contract.
3. Pick the next `status: ready` task from [`tasks/INDEX.md`](./tasks/INDEX.md) whose dependencies are all `done`.
4. Move it to `status: in-progress`, do the work, satisfy the acceptance criteria, move it to `status: done`, and update `INDEX.md`.
5. If blocked, set `status: blocked` and write the blocker in the task file.

Never start a task whose dependencies aren't `done`. Never modify a task someone else has marked `in-progress` without coordinating.
