---
id: P4-003
title: Transcript FTS index + search UI
phase: 4
workstream: A
status: done
owner: claude
depends_on: [P1-012]
blocks: [P4-002]
estimate: L
---

## Goal

Create a Postgres FTS `transcript_index` table, populate it nightly from S3 transcripts, and expose search via the `/org/search` page.

## Acceptance criteria

- [x] `transcript_index` table created via SQL migration `0003_transcript_fts.sql`
- [x] GIN index on `content_tsv` (generated tsvector column)
- [x] `index-transcripts` job populates 200 unindexed sessions per nightly run
- [x] FTS search in `org-queries.ts` uses `plainto_tsquery` + `ts_headline` for excerpts
- [x] Search scoped to users with `shareTranscriptsWithOrg=true`
- [x] Search UI in `/org/search` shows excerpts with highlighting

## Files touched

- `packages/db/sql/migrations/0003_transcript_fts.sql` (new)
- `apps/ingest/src/jobs/index-transcripts.ts` (new)
- `apps/ingest/src/jobs/scheduler.ts`
- `apps/web/src/lib/org-queries.ts` (searchTranscripts)
- `apps/web/src/app/org/search/page.tsx`
