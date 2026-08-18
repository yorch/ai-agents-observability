# Phase 12 — Agent Adapter Expansion (roadmap)

**Trigger to decompose**: The 2026 hook-system convergence. Between P8 (three
adapters: claude-code, opencode, codex) and today, **Codex, GitHub Copilot CLI, and
Gemini CLI all shipped stdin-JSON command hooks with Claude Code's payload shape**,
and two new plugin-shaped agents (**Pi**, **OMP**) arrived with single-file JSONL
sessions carrying token usage *and* cost. The seam built in P8-003 holds for all of
them without a schema change — but building five more bespoke adapters would be the
wrong response to agents that now largely agree on a format.

Research + sourcing: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md).

**Status**: P12-001 through P12-012 are code complete, with the migration verified against a real Postgres-Timescale container. Three acceptance criteria remain unchecked for want of the agents themselves: a recorded Pi session (P12-007), which of omp's two documented config roots is real (P12-008), and a recorded opencode session for the collated transcript (P12-009).

## Goal recap

Go from three agents to seven, while *reducing* per-adapter code:

- **One factory, not N adapters.** Claude Code, Codex, Gemini CLI, and Copilot CLI
  differ by an event-name map and a few field aliases. Extract
  `createStdinHookAdapter(...)` from `claude-code.ts` and make the rest config.
- **Fix the session-ID hole first.** `EventSchema` requires a UUID `session_id`;
  ingest `safeParse`s per event and drops invalid ones. opencode's real IDs are
  `ses_`-prefixed, so live opencode traffic is silently discarded today — the unit
  test only ever feeds UUID-shaped fixtures. OMP (16-hex) and Copilot would hit the
  same wall. One normalization step in the seam fixes all of them.
- **Upgrade Codex rather than freeze it.** Codex's native lifecycle hooks make most
  of P8-007's rollout-tailing machinery (byte cursor, `mapBatch` expansion)
  unnecessary; the rollout read narrows to token usage, which the hooks don't carry.
- **Close the transcript gap.** Pi and OMP both store one session per JSONL file, so
  `transcriptTarget()` works for them on day one — unlike opencode, whose
  directory-shaped storage has been a documented follow-up since P8-004.

## Sketched tasks

- **P12-001 Agent registry widening** (WS B, S) — add `PI`, `OMP`, `GEMINI_CLI` to
  `AgentTypeSchema`, the Prisma `AgentType` enum, `agent-display.ts`, and the price
  tables; drive `/admin/adapters` from a registry instead of a hard-coded triple.
- **P12-002 Session-ID normalization** (WS D, S) — a shared `sessionUuid()` in the
  seam that passes UUIDs through and `uuidv5`-derives everything else; fixes the
  opencode drop and covers every future adapter.
- **P12-003 Stdin hook adapter factory** (WS D, M) — extract
  `createStdinHookAdapter` from `claude-code.ts`; claude-code becomes its first
  caller with byte-identical output.
- **P12-004 Codex native lifecycle hooks** (WS D, M) — move Codex onto its hook
  system, keep `notify` as the fallback for the off-by-default flag, narrow rollout
  parsing to usage.
- **P12-005 Gemini CLI adapter** (WS D, M) — factory config + `BeforeTool`→`PreToolUse`
  style event map; MCP context maps to `tool.mcp_server`/`mcp_tool`.
- **P12-006 Copilot CLI adapter** (WS D, M) — factory config + camelCase/PascalCase
  dual field reading; `postToolUseFailure` folds into `PostToolUse`.
- **P12-007 Pi adapter** (WS D, M) — TS extension that shells out; native UUID
  session IDs, per-message usage + cost, single-file JSONL transcript.
- **P12-008 OMP adapter** (WS D, M) — TS hook module; probe `~/.omp/` and
  `~/.oh-omp/`; skip the 256-byte title slot when parsing transcripts.
- **P12-009 opencode transcript export** (WS D, M) — the P8-004 follow-up: export
  opencode's directory-shaped history into a single file the shipper can take.
- **P12-010 price-table refresh** (WS B, S) — added after the phase's original
  scope. Fills the tables P12-001 registered empty, refreshes the two that had
  gone stale, and fixes the token accounting they rest on: OpenAI and Google
  report one inclusive prompt total with the cached tokens inside it, which the
  four-rate cost model billed twice.
- **P12-011 reprice history + unpriced visibility** (WS B, M) — the two things
  P12-010 left: an operator-triggered `reprice-events` job that carries a table
  correction back through stored events, session totals, PR rollups and the cost
  continuous aggregates; and naming the models nothing prices, on
  `/admin/price-tables` and in the `unknown_model_surge` alert.
- **P12-012 generate the provider-agnostic tables** (WS B, M) — acting on what
  P12-011 surfaced. Pi, omp and opencode drive any provider the user holds
  credentials for, so their tables are generated from models.dev — the catalog
  opencode itself builds its model list from, so the keys are the names the
  adapter reports — taking coverage from ~34 models across 3 vendors to 243
  across 20.

Explicitly **not** in this phase, each for a stated reason (research §2.6–2.7):
**Cursor** (the CLI reportedly emits only shell events — no session lifecycle, no
usage), **Amp** (no hook documentation found; needs its own research pass),
**Aider** (no hooks at all — would be a file-tailing adapter, a genuinely different
shape), **Windsurf** (unresearched).

## Exit criteria

- Seven agents ship data end-to-end: claude-code, opencode, codex, gemini-cli,
  copilot, pi, omp.
- An agent whose session ID is not a UUID ingests successfully, and the same session
  resolves to the same `session_id` across every event in it.
- The four stdin-hook adapters share one implementation; adding an eighth
  stdin-hook agent is a config object, not a file.
- Codex per-tool events arrive from hooks (not rollout inference) when
  `[features] hooks = true`, and the `notify` path still works when it is off.
- Pi and OMP sessions upload transcripts; opencode's transcript gap is closed.
- Single-agent `claude_code` users see no behavior change — the factory refactor is
  output-identical.

## Dependencies

Builds directly on P8: the seam (P8-003), tool-name disambiguation (P8-001), and
per-agent price tables (P8-002). No dependency on P9/P10/P11.
