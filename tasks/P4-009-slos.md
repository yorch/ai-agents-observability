---
id: P4-009
title: SLO definitions + error budgets
phase: 4
workstream: D
status: done
owner: claude
depends_on: []
blocks: [P4-010, P4-011]
estimate: S
---

## Goal

Define measurable SLOs for all services and scheduled jobs, with error budget policy.

## Acceptance criteria

- [x] SLOs defined for: ingest (99.5% avail, p99 < 200ms), web (99% avail, p95 < 1s), github-app (99% delivery success)
- [x] Job completion targets and alert thresholds for all 6 scheduled jobs
- [x] Error budget policy (>50% → review, 100% → freeze, GDPR always P1)
- [x] Future SLIs section (org dashboard, FTS query)

## Files touched

- `docs/slos.md` (new)
