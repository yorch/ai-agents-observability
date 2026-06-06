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
| [P2-010](./P2-010-ghes-integration-test.md) | GHES integration test for webhook + bot flows | review | claude | M | P2-003, P2-006 |

## Phase 3 — Team views

### Workstream A — Auth / middleware

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P3-001](./P3-001-role-middleware.md) | Role middleware (team_lead) + requireRole helper | done | claude | M | P1-003, P1-014 |

### Workstream B — Team UI

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P3-002](./P3-002-team-overview.md) | /team/[slug] overview page | done | — | M | P3-001 |
| [P3-003](./P3-003-team-roster.md) | /team/[slug]/roster page | done | — | M | P3-001, P3-005 |
| [P3-004](./P3-004-team-member-drill-in.md) | Drill-in to team member sessions | done | claude | M | P3-003, P3-005 |
| [P3-007](./P3-007-me-audit-filters.md) | /me/audit with filters + real Phase 3 data | done | claude | S | P3-005 |

### Workstream C — Privacy / correctness

| ID | Title | Status | Owner | Est | Depends on |
|---|---|---|---|---|---|
| [P3-005](./P3-005-audit-log-writes.md) | Audit log writes on every cross-user view | done | claude | M | P3-001 |
| [P3-006](./P3-006-privacy-test-suite.md) | Privacy enforcement property-test suite | done | claude | M | P3-005 |

## Phase 4 — Org views, search, ops handoff

See [`P4-roadmap.md`](./P4-roadmap.md).

## Phase 5 — Effectiveness signals

See [`P5-roadmap.md`](./P5-roadmap.md).
