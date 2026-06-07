---
id: P4-008
title: Runbooks (5 failure scenarios)
phase: 4
workstream: D
status: done
owner: claude
depends_on: []
blocks: [P4-011]
estimate: M
---

## Goal

Written runbooks for the five most likely failure scenarios. Each: symptoms, diagnosis steps, mitigations, escalation thresholds.

## Acceptance criteria

- [x] `docs/runbooks/ingest-down.md` — ingest service down/unhealthy
- [x] `docs/runbooks/minio-full.md` — MinIO disk full or unreachable
- [x] `docs/runbooks/timescale-slow.md` — Postgres/TimescaleDB slow or unreachable
- [x] `docs/runbooks/oauth-broken.md` — GitHub OAuth login broken
- [x] `docs/runbooks/webhook-failing.md` — GitHub webhook delivery failures

## Files touched

- `docs/runbooks/ingest-down.md` (new)
- `docs/runbooks/minio-full.md` (new)
- `docs/runbooks/timescale-slow.md` (new)
- `docs/runbooks/oauth-broken.md` (new)
- `docs/runbooks/webhook-failing.md` (new)
