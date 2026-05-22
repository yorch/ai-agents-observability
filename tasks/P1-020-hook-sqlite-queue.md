---
id: P1-020
title: SQLite queue + hook entrypoints (<10ms)
phase: 1
workstream: D
status: review
owner: claude
depends_on: [P1-019, P1-006]
blocks: [P1-021, P1-022, P1-028]
estimate: L
---

## Goal

Each Claude Code hook event (`session-start`, `pre-tool-use`, `post-tool-use`, `stop`, …) is consumed via stdin, mapped to an `Event` (P1-006 schema), and written to a local SQLite queue at `~/.claude-telemetry/queue.db` in under 10ms. Reliability and speed are the only goals here.

## Context

- `DESIGN_DOC.md` §6.2 specifies the <10ms budget and the offline-first principle.
- The hook is invoked synchronously by Claude Code on every tool call — any latency we add is felt as a slower agent.
- The flusher (P1-021) is a separate process that drains the queue.

## Acceptance criteria

- [ ] CLI subcommand for each Claude Code hook trigger: `claude-telemetry hook session-start`, `... pre-tool-use`, etc. Stdin is JSON from Claude Code.
- [ ] Each subcommand:
  1. Reads stdin (size-bound: 1 MB max).
  2. Parses Claude Code's hook payload.
  3. Translates to `Event` per `@pkg/schemas`.
  4. Computes `event_id` (UUID v7), `session_id`, `user_id_claim`, agent_type, event_type, plus optional fields.
  5. Inserts into SQLite `events_queue` table.
  6. Exits 0.
- [ ] SQLite database at `~/.claude-telemetry/queue.db` (configurable via `CLAUDE_TELEMETRY_HOME`).
- [ ] `events_queue` schema: `(event_id text primary key, ts text, payload_json text, attempted_at text, attempts int default 0)`.
- [ ] WAL mode + `synchronous=NORMAL` for speed.
- [ ] `--quiet` flag: errors go to a log file (`~/.claude-telemetry/hook.log`) not stderr, so a broken hook never breaks the user's Claude Code session.
- [ ] Hard fail-safe: if SQLite open fails (e.g., disk full), still exit 0 within 10ms. Drop the event silently (logged to file). Reliability > completeness.
- [ ] Benchmark in P1-028 will measure the budget; this task provides a local microbench script proving <10ms p99 over 1000 runs on the developer's machine.
- [ ] All errors caught — no uncaught throws.

## Implementation notes

- Use `bun:sqlite` (compiles in with the binary). Don't go via FFI.
- Open the DB lazily once; keep the connection in a global. But: the hook is a short-lived process, so the cost is open + insert + close every invocation. Optimize via `PRAGMA temp_store=memory` and prepared statement reuse… but realistically, SQLite open is fast (~1ms).
- Reading stdin: `await Bun.stdin.text()` is the simplest path. Time-out at 100ms in case Claude Code holds the pipe.
- Session ID derivation: read from Claude Code's payload directly (it's part of the hook contract). Don't synthesize.

## Files touched

- `apps/hook/src/cli.ts` (expanded)
- `apps/hook/src/hook-entry/{session-start,pre-tool-use,post-tool-use,stop,...}.ts`
- `apps/hook/src/lib/queue.ts`
- `apps/hook/src/lib/log.ts`
- `apps/hook/test/queue.test.ts`
- `apps/hook/bench/hook.bench.ts`

## Out of scope

- Flushing to network (P1-021).
- Transcript handling (P1-022).
- Subcommands like `login`, `status` (P1-023).

## Verification

```bash
bun --filter '@app/hook' test
echo '{"session_id":"...", ...}' | ./apps/hook/dist/claude-telemetry-<triple> hook pre-tool-use
sqlite3 ~/.claude-telemetry/queue.db 'SELECT count(*) FROM events_queue;'
bun --filter '@app/hook' bench  # p99 < 10ms
```
