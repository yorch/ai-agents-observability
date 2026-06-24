---
id: P8-002
title: Per-agent versioned price tables
phase: 8
workstream: B
status: ready
owner: null
depends_on: [P1-013]
blocks: [P8-004, P8-006]
estimate: M
---

## Goal

Generalize the single `price-table.v1.json` into per-agent versioned tables so that a non-Anthropic agent's models price correctly via their own table, while `claude_code` pricing is unchanged. This is the deferred **P6-005**.

## Context

`apps/ingest/src/lib/cost.ts` keys cost lookup on `model` string only, against `apps/ingest/src/data/price-table.v1.json`. DESIGN_DOC.md §11.6 states "Cost computation accepts per-agent price tables, not a global one" — but this has never been built. P6-005 was deferred until a second agent arrived whose models collide with or price differently from Anthropic's. That trigger is now met (P8-004 is landing opencode). `PriceTableSchema` in `packages/schemas` defines `{ version, generated_at, prices: Record<model, {input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok}> }`. The schema needs no structural change — an `agent` field is optional metadata, not required for lookup.

The `/v1/price-table` endpoint (P1-013) exposes the current table read-only. It must be updated to serve the right table for a given `agent` query parameter.

`unknown_model_events_total` Prometheus counter already fires on `$0` cost; that behavior is preserved per (agent, model), not just model.

## Acceptance criteria

- [ ] Price tables live at `apps/ingest/src/data/price-table.<agent>.v1.json` (e.g. `price-table.claude_code.v1.json`, `price-table.opencode.v1.json`); the old `price-table.v1.json` is retained as the `claude_code` default or removed with a clear migration note.
- [ ] `cost.ts` looks up cost on `(agent_type, model)`; falls back to `$0` and increments `unknown_model_events_total` for any `(agent_type, model)` pair not in the table.
- [ ] `claude_code` session costs are numerically unchanged.
- [ ] `GET /v1/price-table?agent=opencode` returns the opencode table; `GET /v1/price-table` (no param) defaults to `claude_code`.
- [ ] `version` and `generated_at` are present in every table so historical cost is reproducible.
- [ ] `bun run typecheck` passes; `bun run check` passes.

## Implementation notes

File naming: `price-table.claude_code.v1.json`, `price-table.opencode.v1.json`. Load at startup into a `Map<agent_type, PriceTable>` so lookups are O(1). The `v1` suffix leaves room for `v2` when Anthropic changes structure, without breaking historical cost reproductions (keep old files; the ingest version header controls which table a stored event was priced against).

`PriceTableSchema` in `packages/schemas` does not need an `agent` field added — the agent is the lookup key, not part of the table payload. Only touch the schema if a structural change is needed.

## Files touched

- `apps/ingest/src/data/price-table.claude_code.v1.json` (rename / copy from `price-table.v1.json`)
- `apps/ingest/src/data/price-table.opencode.v1.json` (new, populated in P8-004)
- `apps/ingest/src/lib/cost.ts`
- `apps/ingest/src/app.ts` (price-table route — add `agent` query param)
- `packages/schemas/src/price-table.ts` (only if structural schema change needed)

## Out of scope

- Populating the opencode price table with real prices — that is P8-004's responsibility; this task stubs an empty/placeholder table.
- Automatic price-table refresh from vendor APIs — see P8-006.
- Per-version cost reconciliation UI.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@app/ingest' test

# Endpoint check (requires running ingest):
curl http://localhost:3001/v1/price-table | jq '.version'
curl 'http://localhost:3001/v1/price-table?agent=opencode' | jq '.version'
curl 'http://localhost:3001/v1/price-table?agent=unknown_agent' # should 404 or return claude_code default — document the choice
```
