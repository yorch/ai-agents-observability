# Phase 8 — Multi-Agent & Cost Model (roadmap)

**Trigger to decompose**: Post-P6 gap assessment. The multi-agent spine is in place (P5-006 done: `agent_type` enum widened to all seven agents, ingest/read paths agent-neutral) but unproven at the seam level — no second agent has ever shipped data through it. Meanwhile, two P6 items were explicitly deferred awaiting a concrete second-agent requirement: **P6-005 (per-agent price tables)** and **P6-006 (hook adapter seam)**. This phase builds the remaining foundation pieces and lands a real second adapter to validate that the spine actually holds.

## Goal recap

Accept a second coding agent end-to-end without schema migration:

- **Tool-name disambiguation** — the `<agent>:<tool>` convention described in DESIGN_DOC.md §2.4 is documented but not built; two agents emitting a tool named `"Edit"` would collide in every aggregate today.
- **Per-agent versioned price tables** — `cost.ts` keys on model string only; when a second agent ships models with different (or colliding) names, billing silently falls back to `$0` and increments `unknown_model_events_total`. Each agent needs its own table.
- **Hook adapter seam** — the transport (queue, flusher, shipper, retry/abandon, transcript machinery) is already agent-neutral per DESIGN_DOC.md §6.3; only `payload.ts`, the `~/.claude` paths, and the install/uninstall commands are Claude-specific. The seam must be extracted from two real examples to avoid the wrong abstraction (per P6-006's deferral note).
- **De-Claude-ified copy** — agent labels in PR-bot comments (DESIGN_DOC.md §7.4) and the /me dashboard are hard-coded to "Claude"; a multi-agent org will see wrong labels.

References: DESIGN_DOC.md §2.4 (Multi-Agent Extensibility), §6.3 (hook payload contract), §11.6 (cost computation), §15 (cross-tool unification).

## Sketched tasks

- **P8-001 Tool-name disambiguation** (WS B, M) — implement the `<agent>:<tool>` collision-avoidance convention from §2.4, either prefix-on-write or disambiguate at query time; consistent across ingest and all read queries.
- **P8-002 Per-agent price tables** (WS B, M) — generalize `price-table.v1.json` → `price-table.<agent>.v1.json`, key cost lookup on `(agent_type, model)`, update `/v1/price-table` endpoint. *This is the deferred P6-005.*
- **P8-003 Hook adapter seam** (WS D, L) — extract an `Adapter` interface in `apps/hook`; Claude Code becomes the first implementation; the transport is untouched. *This is the deferred P6-006.*
- **P8-004 Second-agent adapter** (WS D, L) — implement a real second-agent adapter (opencode) that exercises the seam end-to-end and finalizes the `Adapter` interface from real usage.
- **P8-005 De-Claude-ify copy** (WS E, S) — drive all user-facing agent labels from `agent_type` instead of hard-coding "Claude" in the PR-bot comment and /me dashboard.
- **P8-006 Cost reconciliation** (WS B, M) — design + scaffold reconciliation of client-computed cost against a vendor billing API; gated per DESIGN_DOC.md §13 Q4 / PLAN §5.

## Exit criteria

- A second agent's sessions ingest, price correctly via its own price table, and render with correct agent labels — with no schema migration required.
- Two agents emitting a tool named `"Edit"` are distinguishable in every tool aggregate (per-session, team, org, `daily_tool_usage`).
- The hook transport (queue, flusher, shipper, retry/abandon, transcript) is shared between two adapter implementations without any forking of transport code.
- The `Adapter` interface is finalized from two real examples, not one.
- Single-agent `claude_code` users see no behavior change.

## Deferred items landed in this phase

- **P6-005 (Per-agent price tables)** → P8-002
- **P6-006 (Hook adapter seam)** → P8-003 + P8-004
