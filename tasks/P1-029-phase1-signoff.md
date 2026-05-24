---
id: P1-029
title: Phase 1 exit-criteria sign-off
phase: 1
workstream: F
status: blocked
owner: null
depends_on: [P1-011, P1-012, P1-020, P1-023, P1-024, P1-025, P1-026, P1-027, P1-028]
blocks: []
estimate: S
---

## Goal

Run the Phase 1 exit criteria (PLAN.md §3) end-to-end on a fresh machine and document the result. If all green, mark Phase 1 done and begin decomposing Phase 2.

## Context

- `PLAN.md` §3, Phase 1 exit criteria block.
- This task is intentionally last in the dependency chain — everything else must be `done` before this can be claimed.

## Acceptance criteria

- [ ] **Real dogfood**: one engineer runs the hook for at least 5 working days. Sample at least 10 random sessions and verify the data is correct (events match what they did; cost is plausible). Record in `docs/phase1-dogfood.md`.
- [ ] **Page perf**: `/me` p50 < 500ms measured with real (not seeded) data. Method documented.
- [ ] **Hook perf**: p99 < 10ms on dev machine, p99 < 15ms in CI. Cite the `apps/hook/bench/results/*.md` file.
- [ ] **Redaction**: manual review of at least one real transcript confirms no secrets leaked through. Reviewer notes recorded in `docs/phase1-redaction-review.md` (transcript can be referenced by session_id; do NOT commit transcript content).
- [ ] **Purge**: run `claude-telemetry purge-local` after a populated session; verify `~/.claude-telemetry/` is empty (modulo log file).
- [ ] **Clean-clone**: on a fresh checkout, `docker compose up` produces a working stack. Document any deviation from the README in `docs/phase1-cleanclone.md`.
- [ ] **PR / commit retrospective**: a 1-page note in `docs/phase1-retro.md` listing what worked, what didn't, what to do differently in Phase 2.
- [ ] All P1-* tasks in `INDEX.md` marked `done`.

## Implementation notes

- Treat this as an audit, not a code task. The deliverables are docs, not code.
- If a criterion fails, do NOT mark this task done. File a follow-up task and block on it.

## Files touched

- `docs/phase1-dogfood.md`
- `docs/phase1-redaction-review.md`
- `docs/phase1-cleanclone.md`
- `docs/phase1-retro.md`
- `tasks/INDEX.md` (final status sweep)

## Out of scope

- Phase 2 decomposition (separate task, created after sign-off).

## Verification

Verification IS the work. Each acceptance-criterion bullet has its own check.
