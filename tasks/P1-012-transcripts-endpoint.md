---
id: P1-012
title: POST /v1/transcripts (chunked + MinIO)
phase: 1
workstream: B
status: review
owner: claude
depends_on: [P1-008, P1-002, P1-007, P1-009]
blocks: [P1-022, P1-026]
estimate: L
---

## Goal

`POST /v1/transcripts/:session_id` accepts a chunked, zstd-compressed transcript JSONL stream, re-scans it through redaction (defense-in-depth), stores it in MinIO under a deterministic key, and records metadata on the `Session` row.

## Context

- `DESIGN_DOC.md` §6.4 describes transcript upload semantics.
- Transcripts can be large (100s of MB for long sessions); streaming is non-negotiable.
- Object key format: `transcripts/<yyyy>/<mm>/<dd>/<user_id>/<session_id>.jsonl.zst`.
- Retention: 1 year via MinIO bucket lifecycle policy (set in P1-002 follow-up; this task assumes it exists).

## Acceptance criteria

- [ ] Endpoint `POST /v1/transcripts/:session_id` accepts `Content-Type: application/x-zstd` or `application/gzip` body (gzip support added for hook client compatibility while native Bun zstd support was pending).
- [ ] Supports chunked upload via `Content-Range: bytes <start>-<end>/<total>`. Server reassembles in temp storage (or uses MinIO multipart).
- [ ] Validates the requesting user owns the session (`Session.user_id == auth.user.id`); 403 otherwise.
- [ ] Streams the body through a transform that:
  1. Decompresses zstd.
  2. Parses JSONL line-by-line.
  3. Runs each line through `@pkg/redaction.redact`.
  4. Re-compresses zstd.
  5. Streams to MinIO via S3 SDK multipart upload.
- [ ] Records on `Session`: `transcript_s3_key`, `transcript_bytes`, `transcript_redacted` (Boolean), `transcript_uploaded_at`.
- [ ] Idempotent: re-uploading same `(session_id, sha256)` is a no-op returning the existing key.
- [ ] Returns `{ s3_key, bytes, redacted }`. 201 on first upload, 200 on idempotent re-upload.
- [ ] Test: upload a 10 MB synthetic transcript, verify presence in MinIO and metadata on the session row.

## Implementation notes

- Use `@aws-sdk/client-s3` against the MinIO endpoint. Multipart threshold 5 MB.
- For chunked upload, two strategies are acceptable: (a) buffer to a tempfile, then re-stream to MinIO; (b) keep an in-flight multipart upload keyed by `session_id` and append parts. (a) is simpler for v1; switch to (b) if memory pressure shows up.
- The redaction pass is line-by-line over JSONL — bounded memory regardless of total size.
- Reject uploads where the user is not the session owner *before* reading body — short-circuit DoS.

## Files touched

- `apps/ingest/src/routes/transcripts.ts`
- `apps/ingest/src/lib/s3.ts`
- `apps/ingest/src/lib/transcript-pipeline.ts`
- `apps/ingest/test/transcripts.integration.test.ts`

## Out of scope

- Server-side encryption keys (SSE) — Phase 4.
- Search indexing of transcript contents (Phase 4).

## Verification

```bash
bun --filter '@app/ingest' test
# Manual:
zstd apps/ingest/test/fixtures/sample.jsonl -o /tmp/sample.jsonl.zst
curl -sX POST "http://localhost:4000/v1/transcripts/<session_id>" \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/x-zstd' \
  --data-binary @/tmp/sample.jsonl.zst | jq .
mc ls local/transcripts/2026/05/
```
