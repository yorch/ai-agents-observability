# Task Index

Source of truth for task status. Update this in the same commit as the task file. See [`README.md`](./README.md) for the contract.

**Legend**: ready · blocked · in-progress · review · done · cancelled

---

## Phase 1 — Spine + "My Agents"

### Workstream A — Data plane

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P1-001](./P1-001-monorepo-bootstrap.md) | Monorepo bootstrap (Bun + Turborepo + Biome) | done | — | M | — |
| [P1-002](./P1-002-docker-compose-stack.md) | docker-compose dev stack | done | — | M | P1-001 |
| [P1-003](./P1-003-prisma-schema.md) | Prisma schema for dimensional tables | done | — | M | P1-001 |
| [P1-004](./P1-004-timescale-hypertable.md) | Timescale events hypertable + migration runner | done | — | M | P1-003 |
| [P1-005](./P1-005-seed-script.md) | Seed script for local dev | done | — | S | P1-003, P1-004 |

### Workstream B — Ingest API

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P1-006](./P1-006-zod-schemas.md) | Zod schemas for hook payload | done | — | S | P1-001 |
| [P1-007](./P1-007-redaction-package.md) | Redaction package v1 + test cassettes | done | — | M | P1-001 |
| [P1-008](./P1-008-ingest-skeleton.md) | apps/ingest skeleton (Bun + Hono) | done | — | S | P1-001 |
| [P1-009](./P1-009-ingest-auth.md) | Ingest auth middleware + identity verification | done | — | M | P1-008, P1-014 |
| [P1-010](./P1-010-events-endpoint.md) | POST /v1/events handler | done | — | M | P1-008, P1-006, P1-004 |
| [P1-011](./P1-011-session-aggregation.md) | Session aggregation upserts | done | claude | M | P1-010 |
| [P1-012](./P1-012-transcripts-endpoint.md) | POST /v1/transcripts (chunked + MinIO) | done | claude | L | P1-008, P1-002, P1-007 |
| [P1-013](./P1-013-price-table-endpoint.md) | GET /v1/price-table | done | — | XS | P1-008 |

### Workstream C — Auth

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P1-014](./P1-014-identity-provider-interface.md) | IdentityProvider interface + JWT issuance | done | — | M | P1-001 |
| [P1-015](./P1-015-github-client-package.md) | packages/github: host-agnostic Octokit | done | — | S | P1-001 |
| [P1-016](./P1-016-github-oauth-web.md) | GitHub OAuth (web flow) | done | — | M | P1-014, P1-015 |
| [P1-017](./P1-017-device-code-flow.md) | Device-code flow for hook | done | — | M | P1-014, P1-015 |
| [P1-018](./P1-018-team-sync.md) | Team sync cron job | done | claude | S | P1-015, P1-003 |

### Workstream D — Hook

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P1-019](./P1-019-hook-compile-pipeline.md) | Bun compile pipeline + multi-target | done | — | M | P1-001 |
| [P1-020](./P1-020-hook-sqlite-queue.md) | SQLite queue + hook entrypoints (<10ms) | done | claude | L | P1-019, P1-006 |
| [P1-021](./P1-021-hook-flusher.md) | Background flusher | done | — | M | P1-020, P1-010 |
| [P1-022](./P1-022-hook-transcript-shipper.md) | Transcript shipper with redaction | done | — | M | P1-020, P1-012, P1-007 |
| [P1-023](./P1-023-hook-subcommands.md) | Subcommands (login/status/pause/resume/purge/install) | done | claude | M | P1-019, P1-017 |

### Workstream E — Web UI

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P1-024](./P1-024-web-scaffold.md) | Next.js scaffold + OAuth wiring | done | claude | M | P1-001, P1-016 |
| [P1-025](./P1-025-me-overview.md) | /me overview page | done | claude | M | P1-024, P1-011 |
| [P1-026](./P1-026-me-sessions.md) | /me/sessions list + detail + transcript viewer | done | claude | L | P1-024, P1-011, P1-012 |
| [P1-027](./P1-027-me-privacy-audit.md) | /me/privacy + /me/audit | done | claude | M | P1-024, P1-003 |

### Workstream F — Quality

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P1-028](./P1-028-hook-perf-benchmark.md) | Hook perf benchmark (<10ms target) | done | claude | S | P1-020 |
| [P1-029](./P1-029-phase1-signoff.md) | Phase 1 exit-criteria sign-off | ready | — | S | all P1-* |

> **P1-029 was marked `done` here and is not.** Corrected 2026-08-18 against the
> evidence: it requires `docs/phase1-dogfood.md`, `docs/phase1-redaction-review.md`,
> `docs/phase1-cleanclone.md` and `docs/phase1-retro.md`, and **none of the four
> exists**. Its first criterion is five working days of real dogfood, which cannot
> have happened — no rollout has occurred and the corpus is still seed data. Every
> other `P1-*` task is genuinely done; this is the sign-off gate on top of them, and
> it is still open. Nothing depends on it, so this changes no other status.

---

## Phase 2 — PR Loop

### Workstream A — Infrastructure

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P2-001](./P2-001-github-app-registration.md) | GitHub App registration + credentials wiring | review | claude | S | — |

### Workstream B — Webhook pipeline

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P2-002](./P2-002-github-app-service.md) | apps/github-app webhook handler service | done | claude | M | P2-001 |
| [P2-003](./P2-003-pr-upsert-handlers.md) | PR upsert and close event handlers | done | claude | M | P2-002 |
| [P2-004](./P2-004-session-pr-linking.md) | Session ↔ PR linking (real-time + backfill) | done | claude | M | P2-003 |
| [P2-005](./P2-005-pr-rollup-computation.md) | PR rollup computation | done | claude | M | P2-004 |
| [P2-006](./P2-006-pr-bot-comment.md) | PR bot merge-summary comment | done | claude | M | P2-005, P2-007 |

### Workstream C — Config / schemas

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P2-007](./P2-007-repo-config-parser.md) | .aiot.yml repo config parser | done | claude | S | — |

### Workstream E — Web UI

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P2-008](./P2-008-me-prs-page.md) | /me/prs page — per-user PR list with rollups | done | claude | M | P2-005 |

### Workstream F — Quality

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P2-009](./P2-009-webhook-health-metrics.md) | Webhook delivery health metrics | done | claude | S | P2-002 |
| [P2-010](./P2-010-ghes-integration-test.md) | GHES integration test for webhook + bot flows | done | claude | M | P2-003, P2-006 |

## Phase 3 — Team views

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P3-001](./P3-001-role-middleware.md) | Role middleware (team_lead) + requireRole helper | done | claude | M | P1-003, P1-014 |
| [P3-002](./P3-002-team-overview.md) | /team/[slug] overview page | done | claude | M | P3-001 |
| [P3-003](./P3-003-team-roster.md) | /team/[slug]/roster page | done | claude | M | P3-001, P3-005 |
| [P3-004](./P3-004-team-member-drill-in.md) | Drill-in to team member sessions | done | claude | M | P3-003, P3-005 |
| [P3-005](./P3-005-audit-log-writes.md) | Audit log writes on every cross-user view | done | claude | M | P3-001 |
| [P3-006](./P3-006-privacy-test-suite.md) | Privacy enforcement property-test suite | done | claude | M | P3-005 |
| [P3-007](./P3-007-me-audit-filters.md) | /me/audit with filters + real Phase 3 data | done | claude | M | P3-005 |

## Phase 4 — Org views, search, ops handoff

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P4-001](./P4-001-org-dashboard.md) | viewer_aggregate role + org dashboard | done | claude | M | P3-001 |
| [P4-002](./P4-002-faceted-search.md) | Faceted session search | done | claude | M | P4-001 |
| [P4-003](./P4-003-transcript-fts.md) | Transcript FTS index + search UI | done | claude | L | P1-012 |
| [P4-004](./P4-004-continuous-aggregates.md) | Timescale continuous aggregates | done | claude | M | P1-004 |
| [P4-005](./P4-005-anomaly-surfaces.md) | Anomaly surfaces on org dashboard | done | claude | M | P4-001 |
| [P4-006](./P4-006-deletion-runner.md) | Deletion job runner (GDPR) | done | claude | M | P1-003 |
| [P4-007](./P4-007-retention-enforcement.md) | Configurable retention enforcement | done | claude | M | P1-012 |
| [P4-008](./P4-008-runbooks.md) | Runbooks (5 failure scenarios) | done | claude | M | — |
| [P4-009](./P4-009-slos.md) | SLO definitions + error budgets | done | claude | M | — |
| [P4-010](./P4-010-dashboards.md) | Grafana dashboard config | done | claude | M | P4-009 |
| [P4-011](./P4-011-on-call.md) | On-call doc + escalation path | done | claude | M | P4-009 |

## Phase 5 — Effectiveness signals

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P5-001](./P5-001-friction-score.md) | Friction score (compute + surface) | done | claude | M | P1-011 |
| [P5-002](./P5-002-session-clustering.md) | Session-shape clustering | done | claude | M | P5-001 |
| [P5-003](./P5-003-revert-detection.md) | Revert detection | done | claude | M | P2-005 |
| [P5-004](./P5-004-jira-integration.md) | Jira integration (key extraction + link) | done | claude | M | — |
| [P5-005](./P5-005-github-checks.md) | GitHub Checks correlation | done | claude | M | P2-003 |
| [P5-006](./P5-006-multi-agent-readiness.md) | Multi-agent readiness (enum widening, schema decoupling) | done | claude | S | P1-006, P1-003 |

## Phase 6 — Hardening & scale-readiness

See [`P6-roadmap.md`](./P6-roadmap.md) for full rationale, deferrals, and triggers.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| P6-001 | Event-schema discriminated union + hook tool emission | done | claude | M | P1-006 |
| P6-002 | Prometheus coverage for web + github-app | done | claude | S | — |
| P6-003 | Non-blocking transcript pipeline | done | claude | M | P1-012 |
| P6-004 | Explicit org-admin team-lead grants (`/admin/team-roles`) | done | claude | M | P3-001 |
| P6-005 | Per-agent price tables | deferred | — | M | — |
| P6-006 | Hook adapter seam (2nd agent) | deferred | — | L | P5-006 |

> P6-005 and P6-006 are superseded by Phase 8 (`P8-002` and `P8-003`/`P8-004`), which decompose them now that the second-agent work has been scoped.

---

## Phase 7 — Insight Surfaces & Search

See [`P7-roadmap.md`](./P7-roadmap.md). Surfaces effectiveness signals (already computed, never rendered) and deepens search.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P7-001](./P7-001-effectiveness-backfill.md) | Effectiveness backfill (historical sessions) | done | claude | M | P5-001, P5-002 |
| [P7-002](./P7-002-effectiveness-query-layer.md) | Effectiveness query layer (web) | done | claude | S | P7-001 |
| [P7-003](./P7-003-me-effectiveness-widgets.md) | /me effectiveness widgets (friction trend + shape mix) | done | claude | M | P7-002 |
| [P7-004](./P7-004-team-org-effectiveness.md) | Team + org effectiveness dashboards | done | claude | M | P7-002 |
| [P7-005](./P7-005-me-transcript-search.md) | /me transcript search (per-user FTS) | done | claude | M | P4-003 |
| [P7-006](./P7-006-search-facet-enrichment.md) | Search facet enrichment (shape, friction band, agent type) | done | claude | S | P4-002, P7-001 |
| [P7-007](./P7-007-semantic-transcript-search.md) | Semantic transcript search (gated spike) | done | claude | L | P4-003 |

---

## Phase 8 — Multi-Agent & Cost Model

See [`P8-roadmap.md`](./P8-roadmap.md). Builds the remaining multi-agent foundation and lands a real second adapter to validate it. Subsumes deferred P6-005 / P6-006.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P8-001](./P8-001-tool-naming-disambiguation.md) | Tool-name disambiguation (`<agent>:<tool>` convention) | done | claude | M | P5-006 |
| [P8-002](./P8-002-per-agent-price-tables.md) | Per-agent versioned price tables | done | claude | M | P1-013 |
| [P8-003](./P8-003-hook-adapter-seam.md) | Hook adapter seam | done | claude | L | P5-006 |
| [P8-004](./P8-004-second-agent-adapter.md) | Second-agent adapter (opencode) | done | claude | L | P8-003, P8-001, P8-002 |
| [P8-005](./P8-005-de-claude-ify-copy.md) | De-Claude-ify user-facing copy | done | claude | S | P5-006 |
| [P8-006](./P8-006-cost-reconciliation.md) | Cost reconciliation (design + scaffold) | done | claude | M | P8-002 |
| [P8-007](./P8-007-codex-adapter.md) | Codex CLI adapter (notify + rollout parsing) | done | claude | M | P8-003, P8-004, P8-001, P8-002 |

---

## Phase 9 — Alerting & Governance

See [`P9-roadmap.md`](./P9-roadmap.md). Turns passive dashboards into proactive alerts; makes privileged access time-boxed, requested, and narrowly scoped.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P9-001](./P9-001-alert-rules-engine.md) | Alert rules engine (scheduled evaluation) | done | claude | L | P4-004, P4-005 |
| [P9-002](./P9-002-alert-notifications.md) | Alert notification delivery + admin UI | done | claude | M | P9-001 |
| [P9-003](./P9-003-timeboxed-access-grants.md) | Time-boxed access grants (request/approve workflow) | done | claude | L | P3-005 |
| [P9-004](./P9-004-per-team-retention.md) | Per-team retention override | done | claude | M | P4-007 |
| [P9-005](./P9-005-research-role.md) | Research / investigator capability (Audience B) | done | claude | M | P9-003, P3-001 |
| [P9-006](./P9-006-governance-alert-tests.md) | Governance + alerting invariant test suite | done | claude | M | P9-002, P9-005 |

---

## Phase 10 — Model Cost Optimization

See [`P10-roadmap.md`](./P10-roadmap.md). Turns the heuristic `/org/models` routing card into a defensible, governed, persona-appropriate optimization capability grounded in the per-agent price tables. Ranked #1 by impact-to-effort in [`OPPORTUNITIES.md`](../OPPORTUNITIES.md) §4.

> **Reconciled 2026-08-18 by owner decision.** Every row here previously read `done` while every `P10-*.md` file read `status: ready`. Each task was audited against the code rather than against the other document, and the answer differed per task — which is why "`INDEX.md` is the source of truth" would have been the wrong blanket fix in either direction.
>
> - **`P10-002` and `P10-005` were never built**, confirmed by search: no `model_policy` in `schema.prisma`, `sql/migrations/` or either app; no `apps/web/src/lib/model-policy.ts`; no `/admin/model-policy` route; no `disallowed_model` in `packages/schemas`, the alert engine, or the seeds. Both reopened as `ready`. `P10-002` is the load-bearing one — `P10-003`'s constants-removal criterion and all of `P10-005` depend on it.
> - **`P10-001` and `P10-003` shipped their substance but miss named criteria**, so both are `in-progress` with the gaps unticked in their files. The routing layer landed as `routing-queries.ts` (not the planned `routing-analysis.ts`) via P8/P11 work: real, pure, price-table-driven, range-producing. What it lacks is not cosmetic — no `agent_type`/`shape_label` grain, no volume floor, and a savings resolver that draws its target rate from one merged price map, so another agent's economy model can set the denominator for a Claude model. That last is exactly what `P10-001` criterion 5 forbids. `P10-003` fails its own grep: `PREMIUM_PATTERNS` is still declared at `org/models/page.tsx:31`.
> - **One item is a design disagreement, not unfinished work.** `P10-001` says a missing price entry must yield `savings: null`, "never a fabricated number"; the code deliberately falls back to a flat `HAIKU_SAVINGS_RATIO = 0.9` and marks the surface imprecise. Settle that before building the rest.
> - **`P10-004` was not built.** `buildRecommendations` emits five kinds and none is routing or cache, which its criterion 2 requires; `/team/[slug]` has a cache-hit stat but no routing section. Reopened as `ready`. The seam it specifies already exists and is the right shape, so this is an extension rather than new architecture.
> - **`P10-006` is `cancelled`, superseded by [`P13-006`](./P13-006-projection-validation-pattern.md)**, which satisfies all five of its criteria through a general projection registry — persisted ranged claims, `not_yet_measurable` volume gating, and an outcome guard over friction / revert / tool-error movement. `cancelled` rather than `done` because this spec was never implemented as written.

> **Closed 2026-08-20.** The five reopened tasks are built; each task file's audit
> section carries what closed it, kept alongside the original finding rather than
> replaced. `P10-002` landed first because the audit was right that it was
> load-bearing: a shared per-agent model policy in `packages/schemas`, read by both
> apps, an admin route at `/admin/model-policy`, and a `model_policy` table. On top
> of it, `P10-001` gained per-`agent_type` grain and volume floors, `P10-003`'s
> `PREMIUM_PATTERNS` grep now returns nothing, `P10-004` added routing and cache
> kinds to `buildRecommendations`, and `P10-005` shipped `disallowed_model`.
>
> **The design disagreement is settled the way this file framed it.** A missing
> price entry now yields no recommendation at all rather than a flat
> `HAIKU_SAVINGS_RATIO` fallback, and the models it affects are surfaced explicitly
> as unpriced — so an empty recommendation list means "efficient" and never "we
> could not tell". The flat-ratio fallback is gone.
>
> `P10-006` stays `cancelled`. `/org/models` records its claims against `P13-006`'s
> projection registry; nothing here re-implements it.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P10-001](./P10-001-routing-analysis-query-layer.md) | Routing analysis query layer + defensible savings model | done | claude | M | P8-002, P4-004, P7-001 |
| [P10-002](./P10-002-model-policy-config.md) | Shared, configurable model policy | done | claude | M | P8-002 |
| [P10-003](./P10-003-org-model-optimization-dashboard.md) | Org model optimization dashboard | done | claude | M | P10-001, P10-002 |
| [P10-004](./P10-004-team-individual-routing-guidance.md) | Team + individual routing guidance | done | claude | M | P10-001 |
| [P10-005](./P10-005-model-governance-enforcement.md) | Model governance enforcement | done | claude | M | P10-002, P9-001 |
| [P10-006](./P10-006-recommendation-validation-loop.md) | Recommendation validation loop | cancelled | — | M | P10-001, P10-003 |

---

## Phase 11 — Correlation & Jira Integration

Deepens the session↔PR↔repo↔Jira correlation spine: commit-SHA + open-PR link backfill, review/check/push webhook capture, session-level Jira keys, the env-gated Jira issue sync, and the ROI/delivery surfaces on top. Shipped ahead of Phase 10 as a single vertical slice.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P11-001](./P11-001-correlation-deepening.md) | Correlation deepening (sessions ↔ PRs ↔ repos ↔ Jira) | done | claude | L | P2-004, P5-004, P5-005 |
| [P11-002](./P11-002-correlation-follow-ups.md) | Correlation follow-ups (project-key allowlist, bug spend, jira facet) | done | claude | M | P11-001 |
| [P11-003](./P11-003-defect-attribution.md) | Defect attribution & quality correlation (/org/quality) | done | claude | M | P11-002 |
| [P11-004](./P11-004-band-significance.md) | Significance testing on friction-band deltas (Fisher's exact) | done | claude | S | P11-003 |

---

## Phase 12 — Agent Adapter Expansion

See [`P12-roadmap.md`](./P12-roadmap.md). Takes the P8 seam from three agents to seven — Codex onto its native lifecycle hooks, plus Gemini CLI, Copilot CLI, Pi, and OMP — by extracting one stdin-hook factory instead of writing five bespoke adapters, and fixes a live session-ID bug that silently drops opencode traffic today. Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md). Code complete. P12-010 then filled the price tables the adapters shipped empty and corrected the two providers whose token counters are inclusive rather than disjoint; P12-011 added the operator-triggered `reprice-events` job that carries those corrections back through stored history, and surfaced unpriced models on `/admin/price-tables`; P12-012 then acted on what that surfaced, generating the three provider-agnostic tables from the models.dev catalog the agents themselves use (34 models across 3 vendors → 243 across 20). Three acceptance criteria remain unverified for want of the agents themselves: a recorded Pi session (P12-007), which of omp's two documented config roots is real (P12-008), and a recorded opencode session for the collated transcript (P12-009).

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P12-001](./P12-001-agent-registry-widening.md) | Agent registry widening (PI, OMP, GEMINI_CLI) | done | claude | S | P5-006, P8-002 |
| [P12-002](./P12-002-session-id-normalization.md) | Session-ID normalization in the adapter seam | done | claude | S | P8-003 |
| [P12-003](./P12-003-stdin-hook-adapter-factory.md) | Stdin hook adapter factory | done | claude | M | P8-003, P12-002 |
| [P12-004](./P12-004-codex-native-hooks.md) | Codex native lifecycle hooks | done | claude | M | P8-007, P12-003 |
| [P12-005](./P12-005-gemini-cli-adapter.md) | Gemini CLI adapter | done | claude | M | P12-001, P12-003 |
| [P12-006](./P12-006-copilot-cli-adapter.md) | GitHub Copilot CLI adapter | done | claude | M | P12-002, P12-003 |
| [P12-007](./P12-007-pi-adapter.md) | Pi adapter | done | claude | M | P12-001, P12-002 |
| [P12-008](./P12-008-omp-adapter.md) | OMP (oh-my-pi) adapter | done | claude | M | P12-001, P12-002, P12-007 |
| [P12-009](./P12-009-opencode-transcript-export.md) | opencode transcript export (closes the P8-004 gap) | done | claude | M | P8-004, P12-007 |
| [P12-010](./P12-010-price-table-refresh.md) | Price-table refresh + provider-correct token accounting | done | claude | S | P8-002, P12-001, P12-004, P12-005 |
| [P12-011](./P12-011-reprice-history-and-unpriced-visibility.md) | Reprice historical cost + unpriced-model visibility | done | claude | M | P8-002, P8-006, P9-001, P12-010 |
| [P12-012](./P12-012-generate-provider-agnostic-price-tables.md) | Generate the provider-agnostic price tables from models.dev | done | claude | M | P12-010, P12-011 |

---

## Phase 13 — Scoring & Evaluation

See [`P13-roadmap.md`](./P13-roadmap.md). Gives every computed signal provenance and a version, adds scorers that need no content access, captures human labels, and — once real data exists — validates the heuristics that already ship (`friction_score`, `shape_label`) against real outcomes. Decomposed from [`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md) after the owner resolved its first open question: evaluating real sessions against real outcomes is a goal. **Proposed.**

> **Sequenced against seed-only data.** No rollout has happened; the corpus is seed and dev data, and a real rollout is intended but unscheduled. Tasks are therefore placed by two rules: build only what pays off regardless of whether rollout happens, and prefer what gets more expensive with time. Tasks marked *blocked (DP-1)* wait on the data precondition defined once in [`P13-roadmap.md`](./P13-roadmap.md) — ≥10 real users over ≥60 days, ≥200 labelled sessions, ≥100 outcome-linked PRs. They unblock themselves when the corpus arrives; no decision is needed.

### Workstream A — Substrate

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P13-001](./P13-001-scores-substrate.md) | Generic versioned scores table | done | claude | M | — |
| [P13-002](./P13-002-run-kind-dimension.md) | `run_kind` dimension (interactive / ci / eval) | done | claude | S | — |
| [P13-012](./P13-012-run-kind-views.md) | Move the `run_kind` guard into the data layer | done | claude | M | P13-002 |
| [P13-013](./P13-013-scores-time-dimension.md) | Time dimension on the `scores` unique key | done | claude | M | P13-001, P13-004 |

> **Both started as deliberate deferrals and both have since landed.**
> [`P13-012`](./P13-012-run-kind-views.md) is the end state for the `run_kind`
> guard — four rounds of lint-strengthening on this branch each found sites the
> previous round could not see, which is what a rule enforced at the wrong altitude
> looks like. It landed in two parts, filtered views then a Prisma client extension,
> because the second inverts the default and needed its own verification pass.
> [`P13-013`](./P13-013-scores-time-dimension.md) closed a real gap —
> `compute-subject-scores` could not produce the trend its docstring claimed — by
> putting a period on the `scores` unique key.

### Workstream B — Deterministic scorers

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P13-003](./P13-003-deterministic-trajectory-scorers.md) | Deterministic trajectory scorers | done | claude | M | P13-001 |
| [P13-004](./P13-004-skill-mcp-effectiveness.md) | Skill & MCP effectiveness scoring | done | claude | M | P13-001, P13-003 |

### Workstream C — Capture & validation

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P13-005](./P13-005-session-label-capture.md) | Session label capture (versioned rubric) | done | claude | M | P13-001 |
| [P13-006](./P13-006-projection-validation-pattern.md) | Projection registry + realization (generalizes P10-006) | done | claude | M | P13-001 |
| [P13-007](./P13-007-scorer-calibration-analysis.md) | Scorer calibration analysis | blocked (DP-1) | — | M | P13-001, P13-005 |
| [P13-008](./P13-008-scorer-validation-surface.md) | Scorer validation surface | blocked (DP-1) | — | M | P13-001, P13-007 |

### Workstream D — Judge

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P13-009](./P13-009-judge-runner-guardrails.md) | Judge runner + guardrails (own transcripts only) | done | claude | L | P13-001 |
| [P13-010](./P13-010-judge-calibration-drift.md) | Judge calibration + drift alerting | blocked (DP-1) | — | M | P13-005, P13-007, P13-009 |
| [P13-011](./P13-011-arm-judge-for-other-users.md) | Arm the judge for other users' transcripts | blocked | — | S | P13-007, P13-009, P13-010 |

> **Workstream D is split, not deferred.** The runner and every guardrail (consent gating, audit writes, owner-only display, versioned prompt registry, cost recording) are built now and exercised against the operator's own sessions — those are the things that never get retrofitted. The irreversible act, pointing the judge at another person's transcript, is isolated in [`P13-011`](./P13-011-arm-judge-for-other-users.md) behind a calibrated judge **and** an explicit owner decision taken with developers consulted in advance.
>
> **Overlap with `P10-006` — settled 2026-08-18.** [`P13-006`](./P13-006-projection-validation-pattern.md) ships the projected-vs-realized check as a general mechanism (projection registry, pure realization function, outcome guard, volume gating) and applies it to the `/org/models` routing recommendations that [`P10-006`](./P10-006-recommendation-validation-loop.md) specifies. `P10-006` is now `cancelled` as superseded, by owner decision taken with the rest of the Phase 10 reconciliation — `cancelled` rather than `done` because its own spec was never implemented as written. The criterion-by-criterion mapping is in that task file. This branch had asserted the same conclusion unilaterally once and withdrew it; the difference now is that Phase 10's state was audited against the code first.

---

## Phase 14 — Telemetry Fidelity

Closes gaps where the pipeline recorded a *plausible* value rather than a true one, then makes the corrected values usable. Sub-agent identification was dead (no adapter ever emitted the `tool_category = 'agent'` those queries filtered on); the cost on `/org/agents`, `/team/agents`, `/org/mcp` and `/team/mcp` was a `SUM(cost_usd)` over tool events that no producer populates in real telemetry, and was always seed-data fiction; and Claude Code recorded `$0` in steady state.

Real spend accrues per **assistant turn**, not per tool call, so a per-tool cost is necessarily a redistribution of a turn's cost. P14-003 produces the per-turn linkage in the hook; P14-004 defines the redistribution and surfaces it. All seventeen tasks are merged (#117–#120, #124–#128, #130–#132, #134, #136–#140).

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P14-001](./P14-001-subagent-identification-fix.md) | Fix sub-agent identification and stop reporting fabricated tool cost | done | claude | S | — |
| [P14-002](./P14-002-tool-category-taxonomy.md) | Derive the real tool-category taxonomy in the adapter seam | done | claude | M | — |
| [P14-003](./P14-003-claude-code-usage-capture.md) | Claude Code per-turn usage capture + turn linkage | done | claude | M | P14-002 |
| [P14-004](./P14-004-turn-linked-cost-attribution.md) | Turn-linked cost attribution for tools, skills and sub-agents | done | claude | L | P14-001, P14-003 |
| [P14-005](./P14-005-model-routing-attribution.md) | Make the model-routing surfaces read real cost instead of seed fiction | done | claude | M | P14-004 |
| [P14-006](./P14-006-live-turn-linkage.md) | Close live-session turn linkage | done | claude | M | P14-003 |
| [P14-007](./P14-007-copilot-usage-capture.md) | Copilot CLI token-usage capture — documented negative | done | claude | S | — |
| [P14-008](./P14-008-metadata-redaction.md) | Stop passing model and user content through to events.metadata | done | claude | M | — |
| [P14-009](./P14-009-migration-consolidation.md) | Consolidate the custom SQL migration layer back to one file | done | claude | S | P14-004, P14-006 |
| [P14-010](./P14-010-tool-durations.md) | Capture real per-tool durations | done | claude | M | — |
| [P14-011](./P14-011-shared-attribution.md) | One cost-attribution implementation, shared by the seed and ingest | done | claude | S | P14-004 |
| [P14-012](./P14-012-typecheck-gate.md) | Bring the test directories inside the typecheck gate | done | claude | M | — |
| [P14-013](./P14-013-typecheck-gaps.md) | Close the two remaining typecheck bypasses | done | claude | S | P14-012 |
| [P14-014](./P14-014-db-test-isolation.md) | Let the DB-gated suites share a database | done | claude | S | P14-009 |
| [P14-015](./P14-015-copilot-request-cost.md) | Request-denominated cost dimension, and Copilot pricing | done | claude | M | P14-007 |
| [P14-016](./P14-016-copilot-token-capture-reopened.md) | Reopen Copilot CLI token capture | done | claude | S | P14-015 |
| [P14-017](./P14-017-github-billing-reconcile.md) | Reconcile Copilot spend against GitHub's billing API | done | claude | M | P14-015 |

> **Phase 14 exists because green tests are not evidence of true data.** Every task
> here fixes a value that was written, validated, aggregated and displayed — and was
> wrong. [`P14-002`](./P14-002-tool-category-taxonomy.md) found every adapter writing
> a flat `'builtin'` / `'mcp'` against a design doc that had specified eight
> categories since Phase 1. [`P14-003`](./P14-003-claude-code-usage-capture.md) found
> Claude Code — the *first* agent, and the one every dashboard is calibrated on —
> recording `$0` in steady state, because its usage lived in the transcript and only
> the `import` subcommand ever read it.

P14-004 degrades rather than guesses: a tool event whose `turn_number` is NULL gets **no** attribution, and every surface shows what fraction of the window's sessions have turn linkage instead of a false `$0.00`.

> **One gap in `P14-003` is a known, deliberate non-fix.** Live
> `PreToolUse`/`PostToolUse` events carry NULL turn linkage: the tool hooks are
> separate processes that fire *before* the turn's Stop exists, and Claude Code's
> Stop hook fires per response cycle rather than per assistant turn, so no correct
> live turn number is derivable without transcript I/O on the hottest path.
> Attributing tools to the nearest Stop by timestamp would produce a
> plausible-looking dollar figure on the wrong tool — the exact failure mode this
> phase exists to remove — so it was reported instead of approximated. Imported
> sessions carry the full linkage, so the coverage fraction above is low until a
> follow-up closes this.

The model-routing follow-up recorded here while Phase 14 was in flight became [P14-005](./P14-005-model-routing-attribution.md): six reads and the `routing_waste` alert filtered `event_type = 'PostToolUse' AND model IS NOT NULL`, a combination no producer emits, so `/org/models` and a live alert had only ever seen seed data. Those surfaces now read the issuing turn's model through `parent_event_id` and the tool row's `attributed_cost_usd`.

**Both Phase 14 follow-ups are closed** — DB-suite isolation as [P14-014](./P14-014-db-test-isolation.md), Copilot pricing as [P14-015](./P14-015-copilot-request-cost.md). Two others shipped earlier: `PostToolUse.duration_ms` as [P14-010](./P14-010-tool-durations.md), and the untypechecked migrations runner plus the `{} as unknown as Config` casts as [P14-013](./P14-013-typecheck-gaps.md).

**P14-015 overturned a premise this phase reasoned from twice.** `price-table.copilot.v1.json` carried a dated, well-sourced `_comment` asserting that "Copilot does not bill tokens at all". That stopped being true on **2026-06-01**, when GitHub replaced premium requests with token-metered AI credits (1 credit = $0.01) and began publishing per-model USD-per-Mtok rates. The comment was written 2026-08-18 — already ~2.5 months stale — and three separate tasks treated it as settled. Premium requests survive only for "Copilot Pro and Copilot Pro+ subscribers on an existing annual plan who remained on legacy premium request-based billing after June 1, 2026". `copilot.v2` now prices 32 models and keeps request pricing for that cohort.

**The standing lesson: a comment encoding a third party's commercial terms has a shelf life its retrieval date does not advertise. Re-fetch it, do not re-read it.**

**Both remaining follow-ups are now closed, and Phase 14 has no open items.**

- **Copilot token capture is settled, negatively and permanently** ([P14-016](./P14-016-copilot-token-capture-reopened.md)). Reopened on the corrected billing premise, then re-closed on stronger evidence than the first close had: GitHub Copilot CLI's own shipped `schemas/session-events.schema.json` defines a rich per-turn `assistant.usage` event (model, input/output/cache tokens, cost) and pins it `"ephemeral": {"const": true}` — a property the schema documents as *"the event is transient and not persisted to the session event log on disk"*. Ten real `~/.copilot/session-state/<id>/` directories spanning Jan–Aug 2026 contain zero `events.jsonl`, which also resolves the reliability question the first investigation left open. The data is unreachable by the vendor's own design, not merely undiscovered. If GitHub ever persists that event, `copilot.v2` already prices it.
- **GitHub's billing API is wired as a second `BillingSource`** ([P14-017](./P14-017-github-billing-reconcile.md)), which — capture being impossible — is the only remaining path to a real Copilot figure. Attribution stops at org level by necessity: the endpoint returns one aggregate per period, and AI credits meter every GitHub AI product across every seat. Drift for `COPILOT` measures our capture gap, not our arithmetic, so it sets gauges and logs `cost.reconciliation.no_client_token_coverage` without incrementing the breach counter operators page on.

**Standing lessons from this phase, recorded because each cost real work to learn:**

1. **A gate that reports success is not evidence it looked at anything.** `tool_category = 'agent'` matched nothing; the `routing_waste` alert could never fire; `tsc` never saw 80 test files; six green tests exercised objects the app never builds. For any gate you rely on, once, prove it fails on a deliberate violation.
2. **A seed that reimplements production is how a fabricated number survives review** — every query gets written against it and agrees with it. A definition two workspaces must agree on lives in `packages/schemas`; adding a caller is the fix, retyping the definition is the bug.
3. **Re-fetch a vendor's commercial terms; do not re-read them.** A dated, well-sourced comment asserting "Copilot does not bill tokens at all" was ~10 weeks stale when written and misled three consecutive tasks in two opposite directions.
4. **The shipped artifact is the contract, not the docs.** Claude Code's `tool_use_id` and Copilot's un-persisted usage event were both settled from the binary and its bundled schema, after documentation left each ambiguous.

---

## Phase 15 — Post-release follow-ups

Opened after v1.0.0. Phase 14 corrected what the pipeline records and proved it by reading code and running tests. The first task here came out of the opposite exercise — seeding a live database and querying it — which is why it exists at all.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P15-001](./P15-001-seed-fidelity.md) | Seed-fidelity pass — three survivors from a seed-and-verify sweep | done | claude | M | P14-002, P14-006, P14-011 |

**Three defects, one root cause** — the seed computing a value independently instead of deriving it from what it had already written:

- `sessions.total_cost_usd` disagreed with the sum of its own events' `cost_usd` in **1,384 of 1,401** sessions. Production accumulates both from one `computeCostUsd` over the same events (`upsert-session.ts`), so there they agree by construction.
- `tool_use_id` was never populated, leaving [P14-006](./P14-006-live-turn-linkage.md)'s `link-turn-events` join unexercised by seed data.
- Codex and opencode sessions carried Claude Code's tool vocabulary, so `CODEX:Bash` classified as `other` rather than `exec`.

**One follow-up remains open, deliberately unnumbered until picked up.** `tool_action` is seeded behind a `toolName === 'Bash'` literal, while production derives it from the tool *input's* shape (`toolActionFor`, which is agent-agnostic). Codex's `shell` calls therefore get no seeded action rather than a Bash-shaped one — a narrowing in seeded richness, not an incorrectness, and worth closing only if that richness is wanted.

**The standing lesson, which is the reason to keep this phase open: a correctness claim verified only by reading is a hypothesis.** Phase 14 merged seventeen tasks of fixes, each covered by tests. The first hour of actually running the system produced four further findings — the three above plus a `/org/models` empty state that reported suppressed low-confidence spend as evidence of efficient routing ([#156](https://github.com/yorch/ai-agents-observability/pull/156)) — and two of them predated Phase 14 entirely.

---

## Phase 16 — v2.3.0 shipped features

Six product features selected from the business-value assessment, implemented and merged as stacked PRs on 2026-08-31. Each went through research → implementation → adversarial review → fixes → quality gates → PR.

| ID | Title | Status | Owner | PR | Depends on |
|---|---|---|---|---|---|
| S1 | Secret-exposure detection & alerting | done | claude | [#215](https://github.com/yorch/ai-agents-observability/pull/215) | P9-001 |
| C2 | Per-team cost anomaly detection & alerting | done | claude | [#216](https://github.com/yorch/ai-agents-observability/pull/216) | P9-001 |
| C4 | Model routing simulation on /org/models | done | claude | [#219](https://github.com/yorch/ai-agents-observability/pull/219) | P10-003 |
| E2 | Session comparison/diff view | done | claude | [#220](https://github.com/yorch/ai-agents-observability/pull/220) | P7-004 |
| E3 | Prompt pattern mining on /org/prompts | done | claude | [#221](https://github.com/yorch/ai-agents-observability/pull/221) | P7-004 |
| E4 | Real-time session stream for team leads | done | claude | [#222](https://github.com/yorch/ai-agents-observability/pull/222) | P3-002 |

**S1** adds a `secret_exposure` alert rule (seeded in `0002_secret_exposure_rule.sql`) evaluated by the scheduled alert engine, plus a "Recent secret exposures" table on `/org/security`. The rule fires when the count of sessions whose shipped transcript matched a redaction class in the trailing 7 days exceeds the configured threshold (default 5), surfacing the redaction classes and session counts without exposing the secrets themselves.

**C2** adds a `team_spend_spike` alert rule (seeded in `0003_team_spend_spike_rule.sql`) that detects per-team cost anomalies. The rule fires when any team's 7-day average daily spend exceeds 2.5σ (critical 3.5σ) above its own 14-day baseline; the thresholds are fixed in `packages/schemas/src/alerts.ts` and are not per-rule configurable. The evaluation runs inside the existing `evaluate-alerts` job alongside the org-level `spend_spike` rule.

**C4** adds a routing simulator on `/org/models` (`GET /api/org/models/simulate`) that lets an operator model the cost impact of shifting tool traffic from premium to cheaper model tiers. The pure simulation logic (`simulateRouting`) lives in `packages/schemas/src/model-policy.ts` so the seed and the API agree on the arithmetic.

**E2** adds a side-by-side session comparison page at `/org/sessions/compare?left=<id>&right=<id>` showing cost, duration, friction, shape, model, tool mix, and PR/CI/review outcomes. Each session is independently access-checked and audited; both forbidden and missing sessions map to `notFound()` to avoid an existence oracle.

**E3** adds a prompt pattern mining page at `/org/prompts` that clusters user prompts by intent (10-intent taxonomy matched via Postgres full-text search) and shows session reach, cost, and friction per cluster. The query drives from `interactive_sessions` with `EXISTS` subqueries so cost/friction are per-session, not multiplied by matching prompt rows. Same trust model as `/org/knowledge`: aggregate, visibility-scoped, small-n suppressed, no conversation content shown.

**E4** adds a real-time SSE endpoint at `/api/team/[slug]/sessions/stream` that polls the DB every 3s for `status='ACTIVE'` sessions and streams snapshots to team leads. The client component (`ActiveSessionStream`) uses `EventSource` with a circuit breaker (5 consecutive errors → close + 10s back-off) to prevent 403/500 reconnect storms. Stream start is audit-logged with `VIEW_SESSION` and `targetTeamId`.
