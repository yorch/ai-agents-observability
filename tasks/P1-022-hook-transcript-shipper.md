---
id: P1-022
title: Transcript shipper with redaction
phase: 1
workstream: D
status: blocked
owner: null
depends_on: [P1-020, P1-012, P1-007]
blocks: []
estimate: M
---

## Goal

When a Claude Code session ends (or after a 10-min heartbeat for long-running sessions), the hook ships the session's transcript JSONL — redacted client-side, zstd-compressed, chunked — to `/v1/transcripts/:session_id`.

## Context

- `DESIGN_DOC.md` §6.4 for upload semantics; §9.1 for redaction classes.
- Transcripts live at `~/.claude/projects/<project_slug>/<session_id>.jsonl`.
- Redaction is double-sided: client-side here, defense-in-depth re-scan in ingest (P1-012).

## Acceptance criteria

- [ ] `claude-telemetry shipper` subcommand watches for transcript files to ship:
  - Triggered by a `stop` hook (writes a marker file `~/.claude-telemetry/ship-queue/<session_id>`).
  - Heartbeat every 10 min on still-active sessions (their marker contains a `partial=true` flag).
- [ ] Pipeline per transcript:
  1. Read JSONL stream from path.
  2. Line-by-line redact via `@pkg/redaction`.
  3. Compute SHA-256 of redacted content (for idempotency check).
  4. zstd-compress.
  5. Chunked PUT to `/v1/transcripts/:session_id` with `Content-Range`.
  6. On success: delete marker, record `transcript_shipped_at` in local DB.
- [ ] Resume support: if the marker file has `bytes_uploaded`, resume from there.
- [ ] Bandwidth ceiling: max 5 MB/s upload (configurable). Don't saturate the user's link.
- [ ] If transcript file is missing (user deleted it), log + delete marker.
- [ ] Same service-file pattern as flusher: launchd/systemd entries installed by `claude-telemetry install`.
- [ ] Test: 50 MB synthetic transcript ships successfully, verified end-to-end in MinIO.

## Implementation notes

- Run the shipper as a separate process (not co-located with the flusher) so memory pressure from large transcripts doesn't affect event flushing.
- Use a streaming zstd encoder (Bun has one) to avoid loading the whole file.
- Don't redact-then-rewrite to disk — keep redaction in-stream. The ingest re-scan is the safety net if a bug here misses something.

## Files touched

- `apps/hook/src/shipper.ts`
- `apps/hook/src/lib/transcript-stream.ts`
- `apps/hook/install/launchd/com.claude.telemetry.shipper.plist`
- `apps/hook/install/systemd/claude-telemetry-shipper.service`
- `apps/hook/test/shipper.test.ts`

## Out of scope

- Encryption-at-rest from the client side.
- Transcript splitting (we ship one file per session).

## Verification

```bash
pnpm --filter=@app/hook test
# Manual:
# Generate a transcript file; touch the marker; run shipper; check MinIO.
mc ls local/transcripts/...
```
