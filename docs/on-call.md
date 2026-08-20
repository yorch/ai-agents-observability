# On-Call Guide

## Overview

This document covers the on-call rotation, escalation paths, and quick-access links for
`ai-agents-observability`. Pair it with the service-specific runbooks in `docs/runbooks/`.

---

## Quick Links

| Tool | Dev (local) | Prod |
|---|---|---|
| Grafana | http://localhost:3001 | `$GRAFANA_URL` (environment-specific) |
| Prometheus | http://localhost:9090 | `$PROMETHEUS_URL` (environment-specific) |
| MinIO Console | http://localhost:9001 | managed S3 in prod |

---

## Grafana

**Dev:** http://localhost:3001

Grafana is provisioned automatically when you run `bun run docker:infra:up`. Log in with
`admin` / `admin` (configurable via `GRAFANA_PASSWORD` env var). Anonymous viewer access is
enabled, so dashboards are readable without logging in.

**Prod:** The production URL is environment-specific. Set `GRAFANA_URL` in your team's runbook
or ops wiki. Authentication in prod should be configured with a real identity provider — disable
`GF_AUTH_ANONYMOUS_ENABLED` and set `GF_SECURITY_ADMIN_PASSWORD` to a strong secret.

**Available dashboards:**

- **Ingest Service** — QPS, error rate, p50/p99 latency, events ingested rate, transcripts stored.

---

## Prometheus

**Dev:** http://localhost:9090

Scrapes:
- `ingest` service at `host.docker.internal:4000/metrics` every 15 s
- `github-app` service at `host.docker.internal:4001/metrics` every 15 s
- `web` service at `host.docker.internal:3000/metrics` every 15 s
- `prometheus` itself at `localhost:9090`

Retention: 15 days (configurable in `infra/prometheus/prometheus.yml`).

---

## Services and Owners

| Service | Port (dev) | Primary runbook |
|---|---|---|
| `apps/ingest` | 4000 | `docs/runbooks/ingest-down.md` |
| `apps/web` | 3000 | — |
| `apps/github-app` | 4001 | `docs/runbooks/webhook-failing.md` |
| Postgres / TimescaleDB | 5432 | `docs/runbooks/timescale-slow.md` |
| MinIO | 9000 / 9001 | `docs/runbooks/minio-full.md` |

---

## Escalation Path

1. **On-call engineer** — first responder. See runbook for the affected service.
2. **Team lead** — escalate after 30 min without mitigation or if the incident is data-loss risk.
3. **Vendor support** — Timescale Cloud (if on managed DB), AWS (if on S3).

Response-time expectations and rotation cadence are maintained in the team's ops wiki.

---

## The judge and the scorers

Two things here behave unlike the rest of the stack, and both are worth knowing
before you are paged about them.

**`judge-sessions` is the only job that spends money per run, and the only one that
sends conversation content to a model.** It is off in three independent ways: seeded
`enabled = false`, wired only when `JUDGE_ANTHROPIC_API_KEY` **and**
`JUDGE_OPERATOR_USER_ID` are both set, and restricted to sessions whose owner set
`allow_judge_analysis`. A fourth restriction — own-sessions-only — is a code constant
(`JUDGE_OWN_SESSIONS_ONLY`), so no deployment configuration can aim it at a third
party. Every read writes an `AuditLog` row visible to the subject.

If judge spend surprises you: disable the job in `/admin/jobs` (takes effect on the
next 60s poll), then read the trailing-30-day cost panel on that page. Unsetting
`JUDGE_ANTHROPIC_API_KEY` and restarting also works and is the harder stop. Do **not**
respond to a cost surprise by clearing `scores` rows — they are the audit trail of
what was spent on what.

**The scorer jobs are idempotent and safe to re-run.** `compute-effectiveness`,
`compute-trajectory-scores` and `compute-subject-scores` upsert on
`(subject_type, subject_id, scorer_name, scorer_version)`, so a partial run followed
by a re-run costs time and nothing else. A failed nightly scorer is **not** a wake-up:
the next night's run covers the gap, and the dashboards degrade to "not yet scored"
rather than to a wrong number.

Re-scoring history after a scorer changes is not a backfill job — bump the version
constant in `packages/schemas/src/scores.ts` and trigger `rescore-effectiveness` or
`rescore-trajectory`. Both are one-shot and dispatchable only from an in-process
operator script, **not** over `POST /admin/jobs/:name/run`.

**A dashboard reporting an implausibly large number is a `run_kind` bug, not a data
bug.** Aggregates are filtered to `run_kind = 'INTERACTIVE'`; a missing filter on one
read admits CI and eval runs and has previously inflated org spend ~28×. Check
whether the offending query carries a fragment from `apps/web/src/lib/run-kind.ts`
before you go looking at the ingest path.

---

## SLOs (target)

| Service | Availability | Latency |
|---|---|---|
| `apps/ingest` | 99.5% | p99 < 200 ms |
| `apps/web` | 99% | p95 < 1 s |
| Webhook delivery | 99% | — |

See `tasks/P4-009-slos.md` for full error budget definitions.
