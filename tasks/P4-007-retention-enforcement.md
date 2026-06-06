---
id: P4-007
title: Configurable retention enforcement
phase: 4
workstream: B
status: done
owner: claude
depends_on: [P1-012]
blocks: []
estimate: M
---

## Goal

Enforce configurable transcript retention: delete S3 objects whose session ended more than `TRANSCRIPT_RETENTION_DAYS` ago, clear the DB pointer, and sweep orphaned S3 keys.

## Acceptance criteria

- [x] `TRANSCRIPT_RETENTION_DAYS` env var in ingest config (default: 365, 0 = disabled)
- [x] `sweep-retention.ts` job: finds sessions with `transcriptUploadedAt < now - retentionDays`, deletes from S3, clears `transcriptS3Key/Bytes/UploadedAt`
- [x] Orphan sweep: lists all objects under `transcripts/`, checks for sessions without a matching pointer, deletes orphans
- [x] Advisory lock prevents concurrent runs
- [x] Skipped entirely when retentionDays=0
- [x] Scheduler runs nightly at 02:00 UTC
- [x] `.env.example` documents the variable

## Files touched

- `apps/ingest/src/config.ts`
- `apps/ingest/src/jobs/sweep-retention.ts` (new)
- `apps/ingest/src/jobs/scheduler.ts`
- `apps/ingest/src/index.ts`
