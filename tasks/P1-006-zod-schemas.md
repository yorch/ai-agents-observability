---
id: P1-006
title: Zod schemas for hook payload
phase: 1
workstream: B
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-010, P1-020]
estimate: S
---

## Goal

`packages/schemas` is the single source of truth for the wire contract between hook and ingest. Hook validates outgoing payloads; ingest validates incoming payloads against the same schemas. Type drift between client and server is impossible.

## Context

- `DESIGN_DOC.md` §6.3 specifies the payload shape.
- Zod gives both runtime validation and TypeScript types from one definition.
- This package is consumed by `apps/hook` and `apps/ingest`. It must build to plain JS without Bun-specific APIs.

## Acceptance criteria

- [ ] `Event` schema covering every field in `DESIGN_DOC.md` §6.3 (event_id UUID, ts ISO8601, session_id, user_id_claim, agent_type enum, event_type enum, optional tool_name / model_name / token counts / cost_usd / duration_ms / status / payload).
- [ ] `SessionContext` schema (git block: repo URL, branch, commit SHA, host; cwd; user_agent).
- [ ] `EventsBatch` schema = `{ session_context: SessionContext, events: Event[] }`. Used as the body of `POST /v1/events`.
- [ ] `TranscriptChunkMeta` schema (session_id, chunk_index, total_chunks, sha256). Header / first-frame for transcript upload.
- [ ] `PriceTable` schema (versioned: `{ version: string, generated_at: string, prices: Record<modelName, { input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok }> }`).
- [ ] All schemas exported alongside their inferred TS types.
- [ ] Round-trip test: a sample valid payload parses; mutations (extra field, missing required, wrong enum) fail with predictable errors.
- [ ] Schema versioning constant `EVENTS_API_VERSION = "1"` exported; ingest will reject mismatched versions.

## Implementation notes

- **Zod 4** syntax. Notable v3→v4 changes that apply here:
  - Top-level string formats: `z.uuid()` (strict RFC 4122 — fine, we emit UUIDv7 which is valid), `z.email()`, `z.url()`. Do not use `z.string().uuid()` (deprecated).
  - For UUIDv7 specifically you can use `z.uuidv7()` if you want to enforce version 7. Recommended for `event_id`.
  - `.strict()` / `.passthrough()` are deprecated — use `z.strictObject({...})` and `z.looseObject({...})` instead.
  - Unified error customization: `{ error: (issue) => ... }` instead of separate `message`/`errorMap`.
  - Defaults inside optionals now apply correctly — relevant for fields like `redaction_flags` defaulting to `[]`.
- `z.iso.datetime({ offset: true })` for ISO 8601 timestamps (new top-level location in v4).
- `agent_type` enum starts with just `["claude-code"]` but is an enum so adding cursor/etc. later doesn't break clients.
- Use `z.discriminatedUnion` on `event_type` if per-type fields differ enough to warrant it; otherwise keep flat with optional fields.

## Files touched

- `packages/schemas/src/event.ts`
- `packages/schemas/src/session-context.ts`
- `packages/schemas/src/transcript.ts`
- `packages/schemas/src/price-table.ts`
- `packages/schemas/src/index.ts`
- `packages/schemas/test/event.test.ts`

## Out of scope

- Schema migrations between versions (no v2 yet).
- Avro / Protobuf — Zod-over-JSON is the wire format.

## Verification

```bash
bun --filter '@pkg/schemas' test
bun --filter '@pkg/schemas' build
```
