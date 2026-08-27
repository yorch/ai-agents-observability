---
id: P14-002
title: Derive the real tool-category taxonomy in the adapter seam
phase: 14
workstream: A
status: review
owner: claude
depends_on: []
blocks: []
estimate: M
---

## Goal

Every producer of telemetry events (all seven adapters, the transcript importer,
and the seed) stamps a real `tool_category` — `fs_read` / `fs_write` / `exec` /
`search` / `web` / `task` / `mcp` / `other`, per `DESIGN_DOC.md` §5.3 — instead of
the flat `'builtin'` / `'mcp'` every producer wrote before this task.

## Context

`DESIGN_DOC.md:412` has always specified the eight-value taxonomy. The hook never
emitted it: every producer (`apps/hook/src/lib/payload.ts`,
`apps/hook/src/lib/import-synth.ts`, `apps/hook/src/adapters/codex.ts`,
`pi-family.ts`, `stdin-hook-factory.ts`, `opencode.ts`, `gemini-cli.ts`) wrote only
`'mcp'` or `'builtin'`. The only place the real taxonomy existed was
`packages/db/src/seed.ts`'s post-seed `finalizeTelemetry()` pass, which
reclassified seeded rows via a hand-written `CASE` under a comment asserting "the
hook emits fs_read/exec/web/…" — true of this design doc, never true of the code.

Consequences, all silently inert while looking healthy against seed data because
seed data was independently fabricated to the correct shape:

- `/org/tools` and `/team/[slug]/tools` "by category" collapsed to builtin/mcp.
- `/org/security`'s risk classification
  (`apps/web/src/lib/security-queries.ts:253`) keys on `fs_read`/`web`/`mcp` and
  found nothing.
- The Phase 10 routing-recommendation engine was inert end to end:
  `DEFAULT_CHEAP_CATEGORIES = ['fs_read', 'search']`
  (`packages/schemas/src/model-policy.ts:21`) fed `apps/web/src/lib/routing-queries.ts`,
  the `/org/models` dashboard, and `apps/ingest/src/jobs/evaluate-alerts.ts`'s
  cheap-category job — none of them could ever match a real row.

## Acceptance criteria

- [x] `toolCategory(agentType, toolName, mcp)` in `packages/schemas` is the single
      source of the taxonomy, with a per-agent tool-name table for every agent with
      a shipped adapter (Claude Code, Codex, Gemini CLI, Copilot, opencode, Pi,
      omp). O(1) — no regex, no scanning — to hold the hook's `<10ms` perf budget.
- [x] Every adapter, `payload.ts`, and `import-synth.ts` call it; no producer still
      writes a bare `'builtin'`.
- [x] MCP detection stays exactly where each adapter already had it (the `mcp__`
      prefix rule, including the `mcp__server`-with-no-tool-segment edge case, plus
      Gemini's `mcp_context` field and Pi/omp's broader `__`-anywhere rule) — the
      shared function takes the already-resolved signal rather than re-deriving it.
- [x] Unknown tool names, and every agent with no shipped adapter, fall back to
      `'other'` — never throw.
- [x] `packages/db/sql/migrations/0002_tool_category_backfill.sql` reclassifies
      existing `PostToolUse` rows from `(agent_type, tool_name, mcp_server)`.
- [x] The seed inserts the true category at row-creation time via the same shared
      function; `finalizeTelemetry()`'s fabricated `CASE` and its false comment are
      removed.
- [x] Unit tests per agent (including MCP edge cases and the unknown-tool
      fallback), a test pinning the taxonomy union itself, and a conformance test
      (in the spirit of `apps/hook/src/adapters/conformance.ts`) asserting every
      adapter's `tool.category` stays inside the declared union.

## Implementation notes

Per-agent tool-name tables are sourced from each adapter's own test fixtures (the
ids/spellings the agent actually emits) plus each agent's publicly documented tool
set where fixtures don't cover a name — see `packages/schemas/src/tool-category.ts`
for the citations. `omp`'s fuller ~32-tool surface (LSP/DAP among them) is not
individually confirmed against a real session; unmapped names fall back to
`'other'` rather than guessing.

## Files touched

- `packages/schemas/src/tool-category.ts`, `tool-category.test.ts`, `index.ts`
- `apps/hook/src/lib/payload.ts`, `import-synth.ts`
- `apps/hook/src/adapters/{codex,copilot,gemini-cli,opencode,pi-family,stdin-hook-factory}.ts`
- `apps/hook/src/adapters/tool-category-conformance.test.ts` (new)
- `apps/hook/src/adapters/stdin-hook-factory.test.ts`, `apps/hook/src/lib/queue.test.ts`
  (golden-output assertions updated from `'builtin'` to the real category)
- `packages/db/src/seed.ts`
- `packages/db/sql/migrations/0002_tool_category_backfill.sql` (new)

## Out of scope

- `apps/web/src/lib/org-queries.ts` and `team-queries.ts` — owned by a sibling PR
  in flight during this task. **Found but not fixed**: both already query
  `tool_category = 'agent'` for their subagent-spawn panels
  (`getSubagentUsage`/equivalent). `'agent'` is not in the `DESIGN_DOC.md` §5.3
  taxonomy and nothing has ever produced it — not the old fabricated seed
  (`'builtin'`), not `finalizeTelemetry()`'s CASE (which mapped `Agent` →
  `'task'`), not this task's `toolCategory()` (which also returns `'task'` for
  Claude Code's `Task` tool). That panel has been silently empty since it was
  written; the fix is to filter on `'task'`, not `'agent'`.
- Cost attribution — separate PR.
- Making the seed's synthetic tool names agent-aware (Codex/opencode seeded
  sessions still draw from the Claude-Code-shaped `TOOL_NAMES` list, so most of
  those rows resolve to `'other'`) — seed's tool-name generation was never
  agent-aware; that is a larger, separate change than wiring the categorization
  function through.

## Verification

```bash
bun install
bun run check
bun run typecheck
bun run build
bun run test
bun run --cwd apps/hook bench   # perf budget, on real hardware — not CI
```

The SQL backfill was reviewed by reading it and by running the migration runner's
own `parseSqlStatements()` against the file to confirm it parses to exactly one
statement. It has **not** been executed against a live database this session —
two sibling agents were running concurrently against the same local machine and
`docker:*` / `db:deploy` / `db:seed` were off-limits. Needs that check at review
time.
