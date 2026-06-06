---
id: P5-006
title: Multi-agent readiness
phase: 5
workstream: A
status: done
owner: claude
depends_on: [P1-006, P1-003]
blocks: []
estimate: S
---

## Goal

Widen the schema, annotate deprecated columns, and document cross-cutting decisions so the platform can ingest telemetry from agents beyond Claude Code (Cursor, Aider, Copilot) without a breaking migration.

## Context

`DESIGN_DOC.md §5` notes that the platform is "Claude Code first" but should not hard-code Claude-specific concepts in the data plane. The original `AgentTypeSchema` was a single-value enum; the Prisma `AgentType` enum had already been widened by migration `0004_p5_features.sql`. This task brings the TypeScript schema and surrounding code into alignment.

## Acceptance criteria

- [x] `AgentTypeSchema` in `packages/schemas/src/event.ts` includes `'cursor'`, `'aider'`, `'copilot'`.
- [x] Existing `agent_type.replaceAll('-', '_')` normalization in `apps/ingest/src/lib/insert-events.ts` handles all new values correctly (single-word values need no transformation).
- [x] A comment near the `tool_name` insert documents the (agent_type, tool_name) query-time disambiguation decision.
- [x] `COMMENT_MARKER` in `apps/github-app/src/lib/pr-comment.ts` is the hidden HTML comment `<!-- ai-agents-observability:pr-summary -->`.
- [x] `buildCommentBody` accepts an optional `agentLabel` param (default `'Claude Code'`).
- [x] `postPRComment` recognises both the new marker and the legacy emoji marker to prevent duplicate comments on existing PRs.
- [x] `opusTurns`, `sonnetTurns`, `haikuTurns` in `packages/db/prisma/schema.prisma` carry `@deprecated` comments explaining the preferred alternative.
- [x] `computeCostUsd` in `apps/ingest/src/lib/cost.ts` has a comment explaining that model names are vendor-specific and carries a `_agentType?` placeholder param to mark the future disambiguation seam.
- [x] `bun run typecheck` passes.
- [x] `bun run check` passes.

## Implementation notes

**AgentType hyphens vs underscores**: the Prisma enum uses underscores (`claude_code`) while the schema uses hyphens (`claude-code`). The existing `replaceAll('-', '_')` in `insert-events.ts` handles the normalisation. New single-word values (`cursor`, `aider`, `copilot`) pass through unchanged.

**Tool naming**: no write-time prefix was added. The decision is: store `tool_name` raw and disambiguate at query time via `(agent_type, tool_name)`. This avoids a migration and keeps historical data consistent.

**PR comment marker**: changed from the emoji string to a hidden HTML comment so the idempotency marker is not visible in rendered PR comments and is not coupled to any agent brand.

**Deprecated columns**: `opusTurns`, `sonnetTurns`, `haikuTurns` were Claude Code-specific placeholders that were never populated. They are annotated but not dropped — dropping would require a migration and there may be data in production.

## Files touched

- `packages/schemas/src/event.ts` — `AgentTypeSchema` widened
- `apps/ingest/src/lib/insert-events.ts` — tool naming comment added
- `apps/ingest/src/lib/cost.ts` — agent-type seam comment + `_agentType?` param
- `apps/github-app/src/lib/pr-comment.ts` — new marker, legacy marker, `agentLabel` param
- `packages/db/prisma/schema.prisma` — `@deprecated` comments on model-turn columns
- `tasks/P5-006-multi-agent-readiness.md` — this file
- `tasks/INDEX.md` — row added

## Out of scope

- Actual hook adapter for Cursor, Aider, or Copilot — deferred until demand is confirmed.
- Per-agent price tables — model names are vendor-unique so a single keyed-by-model table suffices; the `_agentType` seam in `computeCostUsd` is sufficient for now.
- Schema version bump — the schema is backward-compatible; `agent_type` defaults to `'claude-code'`.
- Dropping or migrating the deprecated model-turn columns — kept for data-safety.

## Verification

```bash
# From repo root
bun run typecheck
bun run check
```
