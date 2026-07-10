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
| [P2-007](./P2-007-repo-config-parser.md) | .claude-telemetry.yml repo config parser | done | claude | S | — |

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

See [`P10-roadmap.md`](./P10-roadmap.md). Turns the heuristic `/org/models` routing card into a defensible, governed, persona-appropriate optimization capability grounded in the per-agent price tables. Ranked #1 by impact-to-effort in [`OPPORTUNITIES.md`](../OPPORTUNITIES.md) §4. **Proposed — not yet started.**

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P10-001](./P10-001-routing-analysis-query-layer.md) | Routing analysis query layer + defensible savings model | ready | — | M | P8-002, P4-004, P7-001 |
| [P10-002](./P10-002-model-policy-config.md) | Shared, configurable model policy | ready | — | M | P8-002 |
| [P10-003](./P10-003-org-model-optimization-dashboard.md) | Org model optimization dashboard | ready | — | M | P10-001, P10-002 |
| [P10-004](./P10-004-team-individual-routing-guidance.md) | Team + individual routing guidance | ready | — | M | P10-001 |
| [P10-005](./P10-005-model-governance-enforcement.md) | Model governance enforcement | ready | — | M | P10-002, P9-001 |
| [P10-006](./P10-006-recommendation-validation-loop.md) | Recommendation validation loop | ready | — | M | P10-001, P10-003 |

---

## Phase 11 — Correlation & Jira Integration

Deepens the session↔PR↔repo↔Jira correlation spine: commit-SHA + open-PR link backfill, review/check/push webhook capture, session-level Jira keys, the env-gated Jira issue sync, and the ROI/delivery surfaces on top. Shipped ahead of Phase 10 as a single vertical slice.

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P11-001](./P11-001-correlation-deepening.md) | Correlation deepening (sessions ↔ PRs ↔ repos ↔ Jira) | done | claude | L | P2-004, P5-004, P5-005 |
| [P11-002](./P11-002-correlation-follow-ups.md) | Correlation follow-ups (project-key allowlist, bug spend, jira facet) | done | claude | M | P11-001 |
| [P11-003](./P11-003-defect-attribution.md) | Defect attribution & quality correlation (/org/quality) | done | claude | M | P11-002 |
| [P11-004](./P11-004-band-significance.md) | Significance testing on friction-band deltas (Fisher's exact) | done | claude | S | P11-003 |
