---
id: P4-004
title: Timescale continuous aggregates
phase: 4
workstream: A
status: done
owner: claude
depends_on: [P1-004]
blocks: []
estimate: M
---

## Goal

Timescale continuous aggregate views for daily cost by user, by model, and by tool. Refreshed hourly. Powers org dashboards without hitting raw `events` rows.

## Acceptance criteria

- [x] `daily_cost_by_user` materialized view (day, user_id, agent_type: cost, tokens, tool calls, session count)
- [x] `daily_cost_by_model` materialized view (day, model, agent_type: cost, tokens, distinct users)
- [x] `daily_tool_usage` materialized view (day, tool_name, category: count, deny count, avg duration)
- [x] Refresh policies: start_offset=32d, end_offset=1h, schedule=1h
- [x] Migration `0002_continuous_aggregates.sql` applied idempotently

## Notes

The org dashboard in P4-001 currently uses raw session/events queries. The continuous aggregates are intended for Phase 4 optimization — when dashboard query times exceed 2s on production hardware, swap the raw queries for `daily_cost_by_user` joins. The schema is stable; no app code changes needed at cut-over.

## Files touched

- `packages/db/sql/migrations/0002_continuous_aggregates.sql` (new)
