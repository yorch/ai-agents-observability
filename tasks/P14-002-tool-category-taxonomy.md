---
id: P14-002
title: Tool-category taxonomy in the hook adapters
phase: 14
workstream: A
status: in-progress
owner: claude
depends_on: []
blocks: []
estimate: M
---

## Goal

Every adapter classifies a `PostToolUse` event's `tool_category` into the finer
taxonomy the web layer already assumes (`fs_read` / `fs_write` / `exec` / `web`
/ `search`, alongside the existing `mcp`), rather than the two coarse values
(`'mcp'` / `'builtin'`) every producer emits today.

> **Stub written by the P14-001 agent, running in parallel.** This file records
> what P14-001's investigation surfaced about the gap so the index entry it was
> asked to add has something to link to; it is not a claim on how P14-002 should
> be scoped or implemented. Whoever owns this task should treat the acceptance
> criteria below as a starting hypothesis, not a spec, and correct this file
> freely.

## Context

`apps/hook/src/lib/payload.ts:123`, `import-synth.ts:57`, and
`stdin-hook-factory.ts:142` (reused by `codex.ts`, `pi-family.ts`, and
`gemini-cli.ts` via `buildGenericToolInfo`) all set `category: isMcp ? 'mcp' :
'builtin'`; `opencode.ts:121` hardcodes `'builtin'`. No adapter emits anything
finer.

Several web queries already read `tool_category` as if the finer taxonomy
existed: `apps/web/src/lib/security-queries.ts` filters on `'exec'` / `'web'` /
`'fs_write'` / `'fs_read'`; `packages/schemas/src/model-policy.ts` and
`trajectory.ts` define categories including those values for routing/pricing
policy. In production these predicates currently match nothing, because the
column never holds those values — the only place the finer taxonomy exists
today is `packages/db/src/seed.ts`'s `finalizeTelemetry`, which reclassifies
seeded rows from `tool_name` after the fact (`UPDATE events SET tool_category =
CASE WHEN tool_name = 'Bash' THEN 'exec' WHEN tool_name = 'Read' THEN 'fs_read'
...`) purely so seed data exercises those surfaces.

## Acceptance criteria

- [ ] Every adapter classifies `tool_category` at ingest time using the same
      mapping seed's `finalizeTelemetry` approximates (tool name → `exec` /
      `fs_read` / `fs_write` / `search` / `web` / `mcp` / `other`), so real
      telemetry populates the values the web layer already reads.
- [ ] The mapping lives in one shared place adapters call into, not
      re-implemented per adapter (same shape as `buildGenericToolInfo`).
- [ ] `packages/schemas` documents (or enumerates) the taxonomy so a future
      adapter can't silently emit an unrecognized value the way `'agent'` was
      never recognized.
- [ ] Existing consumers (`security-queries.ts`, `routing-queries.ts`,
      `model-policy`) are re-verified against the new real values, not just
      seed's synthetic ones.

## Implementation notes

Non-binding — the owning agent should replace this section.

## Files touched

- `apps/hook/src/lib/**`
- `apps/hook/src/adapters/**`
- `packages/schemas/src/**`

## Out of scope

- Sub-agent identification (`subagent_type`) — that was P14-001, already
  fixed and independent of this taxonomy.
- Turn-linked cost attribution — P14-003.

## Verification

```bash
bun install
bun run --cwd apps/hook test
bun run --cwd packages/schemas test
bun run check && bun run typecheck && bun run build && bun run test
```
