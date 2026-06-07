---
id: P4-006
title: Deletion job runner (GDPR)
phase: 4
workstream: B
status: done
owner: claude
depends_on: [P1-003]
blocks: []
estimate: M
---

## Goal

Process `DeletionRequest` rows: delete S3 transcript objects, then cascade-delete the user (which cascades all dependent rows via FK). Runs every 6 hours with advisory lock.

## Acceptance criteria

- [x] `run-deletions.ts` job uses advisory lock to prevent concurrent runs
- [x] For each pending request: deletes all session transcript objects from S3, then calls `db.user.delete()` (FK CASCADE handles sessions, events FK, PR links, audit logs)
- [x] S3 delete failures are logged + skipped (not fatal to the deletion)
- [x] `processedAt` is cleared by user cascade delete (row removed)
- [x] Job writes `JobRun` record (observability)
- [x] Scheduler runs every 6 hours

## Files touched

- `apps/ingest/src/jobs/run-deletions.ts` (new)
- `apps/ingest/src/jobs/scheduler.ts`
- `apps/ingest/src/index.ts`
