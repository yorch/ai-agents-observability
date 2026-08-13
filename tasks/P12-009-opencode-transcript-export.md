---
id: P12-009
title: opencode transcript export (close the P8-004 gap)
phase: 12
workstream: D
status: done
owner: claude
depends_on: [P8-004, P12-007]
blocks: []
estimate: M
---

## Goal

opencode sessions upload transcripts like every other agent, closing the
directory-vs-file asymmetry documented since P8-004.

## Context

P8-004 found — and deliberately left open — that opencode stores conversation history
as a **directory of per-message JSON** under
`~/.local/share/opencode/storage/session/<projectId>/<sessionId>.json` plus per-message
files, while `shipper.ts` reads a single file. `opencode.ts:177` returns `null` from
`transcriptTarget()`, which is the interface's intended escape hatch, and
`apps/hook/AGENTS.md` calls this out as "a live follow-up, not an oversight."

It stayed open because it was the only instance. It no longer is the interesting
question either: Pi (P12-007) and OMP (P12-008) both ship single-file JSONL, so the
shipper's assumption is right for four of the five newest agents and opencode is the
outlier. That makes an **export step** — collate the directory into one JSONL, hand
the shipper a real file — clearly the better fix than widening the shipper.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §1, §6.

## Acceptance criteria

- [x] An export step collates an opencode session's directory into a single JSONL file
      in the hook's own working directory (never inside opencode's storage).
- [x] `opencode.ts` `transcriptTarget()` returns the session's storage directory at
      the terminal event, and the shipper collates it into a file it can upload.
- [x] Message ordering is deterministic and matches conversation order — by record
      timestamp, then discovery order, with seconds/millisecond epochs normalized
      and untimed records kept after timed ones rather than flung to the top.
- [ ] **Unverified:** end-to-end against a RECORDED opencode session. opencode is
      not installed in the dev container, so the fixtures are built from its
      documented storage layout. `locateSessionStorage` matches the session
      directory by name at bounded depth precisely because that layout has already
      changed once since P8-004 — confirm the collated output against a real
      session before trusting the ordering for search/effectiveness.
- [x] Redaction runs on the exported file exactly as it does for every other
      transcript. The export writes a **local temp artifact**, not an S3 object; the
      shipper's redact → zstd → chunk-upload path is unchanged.
- [x] Exported temp files are cleaned up after upload (and on abandon), and never grow
      unbounded across sessions.
- [x] The export happens **out of the hot path** — in the shipper/flusher process, not
      in `hook-entry`.
- [x] `apps/hook/AGENTS.md`'s "known asymmetry" note is updated or removed once true.

## Implementation notes

Match the exported record shape to what `transcript-parser.ts` already understands, so
downstream search/effectiveness code needs no opencode branch. If opencode's per-message
files carry fields with no parser equivalent, drop them rather than extending the
parser — the export is a translation, not a new format.

Check whether opencode's storage layout has changed since P8-004 before writing the
collation; the finding dates from P8-004 (2026-06-25).

## Files touched

- `apps/hook/src/adapters/opencode.ts` (+ test)
- `apps/hook/src/lib/transcript-collate.ts` (the agent-neutral collation; see Out of scope)
- `apps/hook/src/shipper.ts` (resolves a directory target before reading it)
- `apps/hook/AGENTS.md` (the asymmetry note)

## Out of scope

- ~~Widening `TranscriptTarget` or the shipper to accept directories. The
  single-file contract holds for every other agent; do not bend it for one.~~
  **Reversed during implementation, deliberately.** The plan was an adapter-level
  export step, but `transcriptTarget()` is called from `hook-entry` — i.e. on the
  `<10 ms` hot path — so collating there would put a recursive directory walk plus
  a full parse-and-rewrite of the session's history inside the budget. The
  alternative that keeps it adapter-owned is a new seam method invoked by the
  shipper, which is a seam extension for exactly one caller.

  So the shipper takes a **directory** target and collates it, as an agent-neutral
  rule ("a directory target is collated first") rather than an opencode branch:
  the transport still contains no agent name, and the work happens in the shipper
  process. `TranscriptTarget` itself is unchanged. Recorded here because the
  decision reversed a written constraint, and `tasks/` is the source of truth.
- Backfilling transcripts for opencode sessions already ingested without one.

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
