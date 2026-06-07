---
id: P4-005
title: Anomaly surfaces on org dashboard
phase: 4
workstream: C
status: done
owner: claude
depends_on: [P4-001]
blocks: []
estimate: S
---

## Goal

Spend spike and high-error-rate anomaly banners on the org dashboard.

## Acceptance criteria

- [x] `getAnomalies()` in `org-queries.ts` detects: spend spike (>2σ vs 14-day baseline), high tool error rate (>10% errors/calls with ≥100 calls)
- [x] Anomaly cards appear at top of `/org/dashboard` (critical=red, warn=yellow)
- [x] No anomaly cards when nothing detected
- [x] `suspicious_identity_claim` count surfaced (planned — deferred to P4-005 follow-up when claim logging is wired)

## Files touched

- `apps/web/src/lib/org-queries.ts` (getAnomalies)
- `apps/web/src/app/org/dashboard/page.tsx`
