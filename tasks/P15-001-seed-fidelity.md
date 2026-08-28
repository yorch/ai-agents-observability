---
id: P15-001
title: Seed-fidelity pass — three survivors from a seed-and-verify sweep
phase: 15
workstream: A
status: done
owner: claude
depends_on: [P14-002, P14-006, P14-011]
blocks: []
estimate: M
---

## Goal

Three defects found by seeding a live database and querying it, not by
reading `packages/db/src/seed.ts`: a seeded session's `total_cost_usd`
disagreeing with the sum of its own events' `cost_usd`, `tool_use_id`
never populated, and Codex/opencode sessions carrying Claude Code's tool
vocabulary. Same root cause each time — the seed computing a number or a
name independently instead of deriving it from what it already wrote or
from the one shared definition production reads.

## Context

Phase 14 spent seventeen tasks removing cases where the seed was a
*second implementation* of the write path — because every dashboard
query gets written against seed data and therefore agrees with it, a
seed that recomputes production's arithmetic (or invents a shape no
producer emits) passes review and stays wrong indefinitely. A
seed-and-verify pass against a live database after that phase closed
found three survivors.

## Defect 1 — session cost did not reconcile with event cost

**1,384 of 1,401 seeded sessions** (before this fix; the exact count
depends on faker's RNG state each run) had `sessions.total_cost_usd`
that disagreed with `sum(events.cost_usd)` for that session's own rows.
In production, `apps/ingest/src/lib/upsert-session.ts` accumulates
`totalCostUsd` from `computeCostUsd(...)` over the very events it writes
`cost_usd` onto, and the upsert accumulates rather than replaces. The
seed computed the two from **independent** random token counts at six
call sites (five callers of `insertEvents()`, plus one inline event
loop in `basicSeed()`), so they very rarely happened to agree.

### The fix

`insertEvents()` now accumulates and **returns** the sum of the
`cost_usd` it writes onto each turn's `Stop` row. Every call site sets
`sessions.total_cost_usd` from that returned sum — via a new
`setSessionCost()` helper, called *after* the events are written —
instead of an independently-derived `calcCost(...)` call on the
session's own random input/output/cache token counts (which remain used
for `totalInputTokens`/`totalOutputTokens`/`totalCacheRead`/
`totalCacheCreation`, out of scope here). The one inline-event-loop site
in `basicSeed()`'s first block got the same treatment: its Stop rows'
`cost_usd` was previously an unrelated random float; it now derives from
`calcCost()` on the same input/output tokens the row itself carries, and
the session's total is set from the accumulated sum.

`seedNonInteractiveRuns()`'s CI/EVAL sessions were **already correct**
— `spec.costUsd` is split evenly across that session's Stop rows and the
session's `total_cost_usd` is set to the same `spec.costUsd` — and are
untouched.

### Why no shared pricing helper

`packages/db` must not depend on `apps/ingest`, and `computeCostUsd`
lives in `apps/ingest/src/lib/cost.ts`. Summing the `cost_usd` values the
seed already produces satisfies the invariant with no shared pricing
helper at all — the seed's own numbers just needed to agree with each
other, not with a second definition of what a dollar costs. Lifting
`computeCostUsd`/`calcCost` into `packages/schemas` (the P14-011 move)
was considered and declined: it would be solving a problem this defect
doesn't have. `computeSessionAttribution` (P14-011) is the one place the
seed *does* need production's real arithmetic, because the downstream
half of attribution redistributes dollars a second, independent
computation would disagree with; reconciling a session total against
its own events needs no such shared definition, only internal
consistency.

**Out of scope, noted per P14-011's own note:** the seed prices every
model at one flat rate (`PRICE_PER_MTOK`/`SEED_MODEL_PRICE`), deliberately
— giving it realistic per-model rates is `calcCost`'s question to answer,
not this task's, because the downstream attribution half redistributes
the very `cost_usd` `calcCost` produces and a different table would
leave the two halves of a seeded session disagreeing.

## Defect 2 — `tool_use_id` never populated

P14-006 added `events.tool_use_id` and the `link-turn-events` job that
joins live tool events to transcript-derived turn linkage on
`(session_id, tool_use_id)`. No seed path ever wrote one:
`SELECT count(*) FROM events WHERE tool_use_id IS NOT NULL` returned 0.

### The fix

`seedToolUseId(agentType)` stamps `toolu_` + a 24-character opaque
suffix — the shape P14-006 confirmed from Claude Code's own hook schema
and the published docs' worked example
(`"tool_use_id": "toolu_01ABC123..."`) — on every `PostToolUse` row the
seed writes for a `CLAUDE_CODE` session: all four `PostToolUse` branches
inside `insertEvents()` (the plain-tool branch, `Skill`, MCP, and
`Task`/subagent), plus the two standalone tool-event sites outside it
(`basicSeed()`'s skill block, `seedNonInteractiveRuns()`'s CI/EVAL tool
row). Every other seeded agent (`CODEX`, `OPENCODE`) keeps
`tool_use_id` NULL, matching `apps/hook/src/lib/payload.ts` — only
Claude Code's adapter promotes one off the wire payload; the other six
adapters set `tool_use_id: null`.

One pre-existing, untouched gap: `basicSeed()`'s very first event loop
(its non-Stop branch) writes a generic placeholder `PostToolUse`/
`PreToolUse`/`UserPromptSubmit`/`SessionStart` row with **no `tool_name`
at all** — not a real tool call in any producer's shape, so it was left
without a `tool_use_id` too, matching the "no tool_name → nothing to
attach an id to" rule everywhere else in the seed.

## Defect 3 — Codex and opencode sessions carried Claude Code's tool names

`CODEX:Bash` categorised as `other` (Codex has no `Bash` tool) while
`CLAUDE_CODE:Bash` categorised as `exec`, because the seed drew every
agent's generic tool name from one Claude-Code-shaped `TOOL_NAMES` list.
Flagged and explicitly deferred by P14-002: *"seed's tool-name generation
was never agent-aware"*.

### The fix

`packages/schemas/src/tool-category.ts` — the source of truth
`toolCategory()` itself reads — now exports `TOOL_NAMES_BY_AGENT`: each
agent's own tool-name vocabulary, derived as the keys of the per-agent
category tables (`CLAUDE_CODE_TOOLS`, `CODEX_TOOLS`, `OPENCODE_TOOLS`,
…) that already existed there. The seed's `insertEvents()` draws a
non-`CLAUDE_CODE` session's generic `tool_name` from that shared table
via a new `pickToolName(agentType)` helper, instead of retyping
Codex's/opencode's names locally — the exact fabrication this phase
exists to remove, just for a tool name instead of a dollar figure or a
category. `CLAUDE_CODE` keeps its existing curated, realistically
weighted `TOOL_NAMES` pool rather than switching to the full (unweighted)
table — that pool was already correct, and this defect is specifically
about the *other* agents.

Also gated the seed's `Skill` (`skill_name`/`slash_command`) and MCP
(`mcp_server`/`mcp_tool` decomposition of an `mcp__server__tool` name)
branches to `CLAUDE_CODE` only. Both are Claude Code payload shapes
(`apps/hook/src/lib/payload.ts`); Codex's and opencode's adapters
(`apps/hook/src/adapters/{codex,opencode}.ts`) leave all four of those
columns NULL even on their own MCP- or skill-shaped tool calls — the
same class of fabrication as the flat tool-name list, just surfacing in
two more branches once the generic name pool was fixed and a
`CODEX:Skill` / `CODEX:mcp__github__list_files` row would otherwise have
appeared.

**Out of scope:** `tool_action`'s seed gate (`toolName === 'Bash'`) stays
Claude-Code-literal — production derives `tool_action` from the tool
*input's* shape (`toolActionFor`, agent-agnostic), not the tool name, so
Codex's `shell` calls now simply never get a seeded action instead of
inheriting Claude Code's Bash-shaped one. That is a narrowing (less
seeded richness for Codex), not a new incorrectness, and giving Codex's
`shell` tool the same treatment is a small, separate follow-up if the
richness is wanted.

## Acceptance criteria

- [x] `SELECT count(*) FILTER (WHERE abs(sess-ev) < 0.01)` /
      `>= 0.01` over every session's `total_cost_usd` vs
      `sum(events.cost_usd)` reports **0 disagreements**, live.
- [x] `tool_use_id` is non-NULL on every `CLAUDE_CODE` `PostToolUse` row
      that carries a `tool_name`, NULL on every `CODEX`/`OPENCODE` row.
- [x] `SELECT DISTINCT agent_type, tool_name, tool_category FROM events
      WHERE event_type='PostToolUse'` shows each agent's own tool
      vocabulary, correctly categorised — no `CODEX:Bash`, nothing
      landing in `other` that should not.
- [x] No regression: the taxonomy is still the real eight values;
      `model` is still on `Stop` rows and not on `PostToolUse` rows;
      `attributed_cost_usd`/`downstream_cost_usd` still populate; the
      sum of `attributed_cost_usd` per session is still ≤ that session's
      `total_cost_usd`.
- [x] Four gates green (`check` → `typecheck` → `build` → `test`) before
      each of the three commits.
- [x] No schema change; `0001_init.sql` untouched; no new dependency
      edge from `packages/db` to an app.

## Verified against a live database, not by reading

`docker:infra:down:v` → `docker:infra:up` → `db:seed:extensive`, twice
(once to get the numbers below, once after an incidental reset caused by
investigating an unrelated pre-existing test failure — see below), each
time followed by `docker:infra:down:v` and `rm -rf data .env`.

Numbers from the final run (1,418 seeded sessions):

| Check | Result |
|---|---|
| session/event cost disagreement | **0** disagree, 1,418 agree |
| `tool_use_id`, `CLAUDE_CODE` | 5,935 with id / 216 without (the untouched no-`tool_name` placeholder rows) |
| `tool_use_id`, `CODEX` / `OPENCODE` | 0 with id (27 / 19 `PostToolUse` rows total) |
| distinct `tool_category` values | the real 8 (`exec fs_read fs_write mcp other search task web`) |
| `model` on `PostToolUse` | 0 |
| `model` on `Stop` | 3,487 of 3,487 |
| `attributed_cost_usd` / `downstream_cost_usd` populated | 5,786 / 4,036 of 15,760 events |
| sessions where `sum(attributed_cost_usd) > total_cost_usd + 0.01` | **0** of 1,418 |

Per-agent `(agent_type, tool_name, tool_category)` for `PostToolUse`
confirmed no `CODEX:*` or `OPENCODE:*` row shares a `CLAUDE_CODE`-only
name (`Bash`, `Read`, `Edit`, …), and each agent's own names resolve to
the same category its production adapter would derive (e.g.
`CODEX:shell → exec`, `CODEX:update_plan → other`,
`OPENCODE:bash → exec`, `OPENCODE:todowrite → other`).

**A pre-existing, unrelated failure surfaced during this verification**
and is **not** part of this task: `apps/ingest/test/reprice-events.db.test.ts`
(2 of 4 tests) fails against this machine's Docker Timescale — one
`Test timed out in 5000ms` on a compression/recompression round-trip, one
consequent assertion failure. Reproduced identically on a **freshly
migrated, unseeded** database (no seed data involved at all), and none
of this task's changes touch `apps/ingest`. Not part of the mandated
four gates (`bun run test` skips `*.db.test.ts` files with no
`DATABASE_URL` set) — flagged here rather than silently worked around.

## Files touched

- `packages/db/src/seed.ts` — `setSessionCost`, `seedToolUseId`,
  `pickToolName`; `insertEvents()` now returns the summed turn cost; all
  six session-cost call sites; `tool_use_id` on all `PostToolUse` writes
  for `CLAUDE_CODE`; `useSkill`/`useMcp` gated to `CLAUDE_CODE`.
- `packages/schemas/src/tool-category.ts` — `TOOL_NAMES_BY_AGENT`.
- `packages/schemas/src/index.ts` — export it.

## Out of scope

- Giving the seed realistic per-model prices (`calcCost`'s question,
  per P14-011).
- `tool_action` for Codex's `shell` (or any other agent's exec tool) —
  see Defect 3 above.
- The pre-existing `reprice-events.db.test.ts` failure noted above.
- Adopting `tool_use_id` for the other five adapters with no shipped
  per-call id (`GEMINI_CLI`, `COPILOT`, `PI`, `OMP`, and any future
  adapter) — unaffected either way, per P14-006's own scope.
