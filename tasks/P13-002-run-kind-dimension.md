---
id: P13-002
title: run_kind dimension (interactive / ci / eval)
phase: 13
workstream: A
status: review
owner: claude
depends_on: []
blocks: []
estimate: S
---

## Goal

Add a `run_kind` dimension (`interactive` | `ci` | `eval`) to sessions and events,
defaulting to `interactive` and excluded from every human-facing aggregate, so
non-interactive agent runs can be ingested and trended without distorting the
metrics the dashboards present as developer behaviour.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§3.3 (R6). `DESIGN_DOC.md` §13 Q8 asks whether CI-side agent runs are in scope and
answers "currently out of scope for v1" while noting the reason: "CI sessions look
different (no human prompts) and could distort aggregates." That is a *dimension*
problem, not a scope problem — the distortion is exactly what a `run_kind` column
prevents.

The forward-looking motive is the agent-config eval harness (skills / `CLAUDE.md` /
MCP regression testing). That harness belongs in CI, not in this repo — but if one is
ever built, the right integration is for it to emit telemetry through the **existing
hook contract** (same batching, auth, and event shapes) tagged as an eval run, so the
platform stores and trends it with no new ingest architecture. This task is the cheap
half of that: the dimension is cheap now and expensive later, the same "capture now,
surface later" logic as `DESIGN_DOC.md` §10.3.

This task does **not** build a harness, and adds no capability to run an agent.

## Acceptance criteria

- [x] `sessions.run_kind` and `events.run_kind` exist, constrained to
      `interactive | ci | eval`, defaulting to `interactive`.
- [x] The hook payload contract in `packages/schemas` accepts an optional run kind in
      `session_context`; omitting it yields `interactive`, so every existing client
      keeps working unchanged with no version bump required.
- [x] Ingest persists the reported value, and an unrecognized value is rejected by
      schema validation rather than stored.
- [x] Every human-facing aggregate — `/me`, `/team/[slug]`, `/org/*`, the continuous
      aggregates, effectiveness computation, and the alert engine — excludes
      non-`interactive` runs by default. This is verified by test, not by inspection.
- [x] The exclusion is centralized (one predicate/helper reused by the query layer),
      not copy-pasted into each query.
- [x] A session with `run_kind != 'interactive'` is still retrievable by its own id
      and still subject to retention, deletion, and visibility rules.
- [ ] **Deferred.** Cost from non-interactive runs is still recorded (the rows are
      stored in full; only the aggregates exclude them), but there is no surface
      that reports it separately yet. Nothing produces a non-interactive run today,
      so the surface would render an empty panel; it belongs with whatever first
      creates such runs. Tracked here rather than silently dropped.

## Implementation notes

- Prisma model change + numbered SQL migration. **Read
  [`packages/db/AGENTS.md`](../packages/db/AGENTS.md)** before touching
  `schema.prisma`.
- The continuous aggregates are the subtle part: adding a filter to a materialized
  aggregate is not a free change. Prefer keeping the caggs as they are and filtering
  at the session/event boundary if the alternative is a cagg rebuild — and if a
  rebuild is needed, say so explicitly in the task notes rather than doing it
  silently. Migration `0005_caggs_add_user_id.sql` is the precedent to read first.
- Default-safe direction matters: the default must be `interactive` so that a client
  that never reports the field is treated as a developer session (the status quo),
  and only an explicit claim moves a run out of the aggregates.
- Do not gate this on trusting the client. A hook that lies about `run_kind` only
  removes its own data from aggregates; there is no privilege attached to the value.

## Files touched

- `packages/db/prisma/schema.prisma`
- `packages/db/sql/migrations/00NN_run_kind.sql`
- `packages/schemas/src/session-context.ts` (+ test)
- `apps/ingest/src/routes/` (events handler), `apps/ingest/src/jobs/compute-effectiveness.ts`
- `apps/web/src/lib/` (shared exclusion predicate + the query modules that adopt it)

## Out of scope

- Building an eval or CI harness of any kind. This is a dimension, not a runner.
- A dashboard for eval runs. Storage and exclusion only; surfacing comes later, if
  ever.
- Changing `DESIGN_DOC.md` §13 Q8's answer to "CI runs are in scope." This task makes
  the answer *cheap to change*; it does not change it.
- Per-run-kind visibility policy. Non-interactive runs follow the same rules as any
  other session.

## Verification

```bash
bun install
bun run --cwd packages/db typecheck
bun --filter '@ai-agents-observability/schemas' test session-context
bun --filter '@ai-agents-observability/ingest' test
bun --filter '@ai-agents-observability/web' test
bun run check
bun run typecheck
bun run build
bun run test
```
