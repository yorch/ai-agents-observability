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
| DB tooling | Prisma for dimensional tables; raw SQL for Timescale hypertable | Prisma cannot manage hypertables natively |
| Retention | 1 year transcripts (object store TTL), indefinite metadata | Spec §10 |
| GitHub host | Both github.com and GHES; host abstracted via `GITHUB_HOST` env | S1 may run GHES |
| Hook install | Opt-in with strong defaults | Trust per §11 |
| SSO | GitHub OAuth now; `IdentityProvider` interface seam for Okta/Azure later | Avoid coupling to GitHub identity |
| Ops handoff | Built by dev tools team; runbooks/SLOs/dashboards delivered in Phase 4 to Platform/SRE | §15 path-to-graduation |
| Existing telemetry pipelines | None — greenfield | Confirmed with user |
| PR bot | Opt-in per repo via `.claude-telemetry.yml` | §11 trust mechanic |

---

## 2. Repo layout

Turborepo + pnpm workspaces. Created in `P1-001`.

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
│   ├── docker-compose.yml   # Postgres+Timescale, MinIO, ingest, web, migrations-runner
│   ├── homelab/             # Compose/systemd for prod-on-homelab
│   └── migrations-runner/   # Init container: Prisma migrate + Timescale DDL
├── tasks/                   # Per-task work units; see tasks/README.md
├── docs/                    # Runbooks (Phase 4), additional design notes
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

- **Language**: TypeScript everywhere. Bun for ingest + hook; Node 20 for Next.js (until Bun-on-Next.js is boring).
- **Style**: ESLint + Prettier configured at the root in `P1-001`. No per-package overrides without justification.
- **Tests**: Vitest. Each `packages/*` ships with unit tests. Each app ships with at least one happy-path integration test. Coverage gates not enforced numerically — judgment-based code review.
- **Migrations**: Forward-only. Backfills written as separate migrations. Never edit a merged migration.
- **Logs**: structured JSON via `pino`. No `console.log` in committed code.
- **Secrets**: never logged, never committed. `.env.example` is the contract; real `.env` is gitignored.
- **Commits**: Conventional Commits. PR per task or per tightly-coupled task group.
- **Branching**: feature branches off `main`; this repo's default working branch is `claude/happy-turing-O39Wq` for the planning phase.

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
| Bun-compiled binary blocked by Mac codesigning | Spike before week 3 of Phase 1 (`P1-017`) | Systems |
| MinIO in homelab = SPOF | Phase 4 ops handoff evaluates HA MinIO vs B2 fallback | Platform/SRE |
| GHES webhook payload drift | `packages/github` version-detects; integration test against a real GHES instance | Backend |
| Privacy regression on team views | Audit log is the safety net; covered by `P3-*` tasks | Cross-cutting |

---

## 7. How AI agents use this plan

1. Read this file end-to-end.
2. Read [`tasks/README.md`](./tasks/README.md) to understand the task contract.
3. Pick the next `status: ready` task from [`tasks/INDEX.md`](./tasks/INDEX.md) whose dependencies are all `done`.
4. Move it to `status: in-progress`, do the work, satisfy the acceptance criteria, move it to `status: done`, and update `INDEX.md`.
5. If blocked, set `status: blocked` and write the blocker in the task file.

Never start a task whose dependencies aren't `done`. Never modify a task someone else has marked `in-progress` without coordinating.
