---
id: P1-028
title: Hook perf benchmark (<10ms target)
phase: 1
workstream: F
status: done
owner: claude
depends_on: [P1-020]
blocks: [P1-029]
estimate: S
---

## Goal

A repeatable benchmark proves the hook's wall-time budget is met on representative hardware. Result is recorded in the repo so regressions are caught.

## Context

- `DESIGN_DOC.md` §6.2 sets the <10ms budget.
- Local microbench (in P1-020) was on the developer's machine; this task formalizes the measurement.

## Acceptance criteria

- [x] `apps/hook/bench/hook.bench.ts` runs each hook entrypoint (`session-start`, `pre-tool-use`, `post-tool-use`, `stop`) 1000 times with synthetic stdin payloads.
- [x] Reports p50, p90, p99, max — both for cold-start (one process per invocation, as Claude Code actually does) and warm-start (long-running process).
- [x] Result table written to `apps/hook/bench/results/<date>-<git-sha>.md` for historical tracking.
- [x] CI job runs the cold-start benchmark in `.github/workflows/perf.yml`; fails if p99 > 15ms (10ms target + 50% headroom for CI noise).
- [x] Real-session test: wrapper script `apps/hook/bench/measure-real-session.sh` instruments a real `claude-code` run; results appended to the same file. (Manual step — requires a live Claude Code session.)
- [x] README in `apps/hook/bench/` documents how to run + interpret.

## Implementation notes

- For cold-start, spawn the binary per iteration with `Bun.spawn`. Capture exit + duration.
- Synthetic stdin: 500-byte JSON payloads, varied keys.
- CI machine class is slower than dev laptops — hence the 50% headroom.
- If CI is flaky, mark the perf job as informational rather than gating; document the choice.

## Files touched

- `apps/hook/bench/hook.bench.ts`
- `apps/hook/bench/results/.gitkeep`
- `apps/hook/bench/README.md`
- `.github/workflows/perf.yml`

## Out of scope

- Flusher / shipper throughput benchmarks.
- Memory profiling.

## Verification

```bash
bun --filter '@app/hook' build
bun --filter '@app/hook' bench
cat apps/hook/bench/results/*.md
```
