# apps/hook — agent notes

> `CLAUDE.md` here is a symlink to this file. Edit `AGENTS.md`.
>
> **Root rules still apply.** Claude Code concatenates this file with the repo-root
> [`AGENTS.md`](../../AGENTS.md); some other agents load only the *nearest* file.
> The invariants most expensive to lose are restated here for that case:
> four gates before every commit (`bun run check` → `typecheck` → `build` → `test`);
> `packages/schemas` is the only source of telemetry event shapes; and **transcripts
> pass `packages/redaction` before they leave the machine** — this app is where that
> first pass happens.
>
> See [`README.md`](./README.md) for the binary's *user-facing* CLI surface. This file
> is for changing the code.

The developer-facing artifact: a Bun single-binary CLI that installs as the host
agent's hook, captures events, and ships them to ingest. It is **not a server**.

## The adapter seam

Per-agent capture lives in `src/adapters/`, dispatched through `index.ts`. The
seam was extracted from two real agents (P8-003/P8-004), not designed up front,
and codex (P8-007) validated it. Seven agents ship today, in three shapes:

| Shape | Agents | How |
|---|---|---|
| **stdin hooks** | claude-code, codex, gemini-cli, copilot | `createStdinHookAdapter()` — a config object each |
| **in-process extension** | pi, omp | `createPiFamilyAdapter()` — they share an event vocabulary; omp is a Pi fork |
| **hand-rolled** | opencode | its own plugin event bus |

**Adding an agent is a new adapter, not a schema change.** If you find yourself
widening `packages/schemas` to fit an agent, the adapter is doing too little.
If the agent speaks Claude Code's stdin hook shape — most now do — it is a config
object, not a file: an event map, field aliases, an install snippet.

Rules the seam has accumulated, every one of them learned the hard way:

- **Normalize the session id** (`lib/session-id.ts`). `EventSchema` requires a
  UUID and ingest silently drops events that fail validation; opencode's real
  `ses_`-prefixed ids meant every live opencode event was discarded from the day
  that adapter shipped, while the tests stayed green on UUID-shaped fixtures
  (P12-002).
- **Test with realistic payloads.** Every adapter test asserts
  `conformanceErrors(event)` is empty using the ids and field spellings the agent
  actually emits. That assertion is what would have caught the above. **Model
  names count.** Fixtures had drifted onto `gemini-3-pro`, `gpt-5.2-codex` and
  `claude-opus-4` — three plausible-looking strings, none of which any vendor has
  ever shipped, so nothing prices them. The tests were green on input that bills
  `$0` in production. Nothing here can enforce that (the price tables live in
  `apps/ingest` and this app must not depend on it), so when you write a fixture,
  copy a model id out of `apps/ingest/src/data/price-table.<agent>.v1.json`.
- **Never invent an `event_type`.** An agent event with no canonical equivalent is
  dropped (Gemini's `BeforeModel`, Copilot's `errorOccurred`, Codex's
  `PostCompact`). Fold near-misses into an existing type instead — Copilot's
  `postToolUseFailure` becomes a `PostToolUse` with a non-zero `exit_status`.
- **Emit *disjoint* token counts.** Ingest's `computeCostUsd` bills `input`,
  `output`, `cache_read` and `cache_creation` each at its own rate and sums, which
  is Anthropic's shape — its `input_tokens` excludes both cache counters. OpenAI
  and Google report the opposite: one inclusive prompt total with the cached
  tokens *inside* it. Subtract in the adapter (`codex.ts`, `gemini-cli.ts` both
  do); passing the provider's number straight through bills the cached tokens
  twice. Same trap in the other direction: Gemini's thinking tokens bill as output
  but sit *outside* `candidatesTokenCount`, so they have to be added in.
- **`metadata` is provenance, never content.** An adapter's known-key list is
  "captured elsewhere, don't duplicate" — it is *not* the privacy boundary. The
  boundary is `admitsToMetadata()` (`packages/schemas/src/metadata-safety.ts`),
  which every passthrough loop must go through: it refuses a shared agent-neutral
  list of content-bearing key names, and refuses any value that is not a JSON
  scalar or is a string over 200 chars. Reading the known-key list as the boundary
  is exactly what put Claude Code's `last_assistant_message` — assistant prose —
  and Copilot CLI's `prompt` into an unredacted Postgres column (P14-008); the
  vendors added those fields after the lists were written, and *unknown ⇒
  verbatim* did the rest. Nothing redacts `events.metadata`: `packages/redaction`
  runs on the transcript path only. `adapters/metadata-content-free.test.ts`
  sweeps every registered adapter over every hook kind and fails if any of them
  passes content through, so a new agent is enrolled the moment it lands in
  `ADAPTERS`.
- **Don't re-implement the payload primitives.** `lib/fields.ts` owns `isRecord`
  and the "first usable value among these keys" readers. Both had drifted into
  several copies with *different* answers about whether an empty string counts —
  which silently collapses a session to the nil UUID.

Two things that look like details and are not:

- **`mapBatch` returning `[]` means "handled, emit nothing"** — distinct from
  `null`, which falls back to `mapPayload`. Gemini's `after-model` is harvested for
  token usage and emits no event, so it depends on this; `hook-entry` uses `??`
  for exactly that reason, and `hook-entry.test.ts` pins it. Changing that to
  `||` would fabricate a Notification per LLM call.
- **Codex runs two capture paths** (native hooks, and the older `notify`), and
  `notify` stands down when our binary is wired as a hook. That check must stay
  narrow: matching a bare `aiot` substring also matches the notify
  wrapper's own path in `config.toml`, which stands the default install down and
  captures *nothing*.

Directory-shaped history is no longer an asymmetry: a `transcriptTarget` that
points at a **directory** is collated into one JSONL by the shipper
(`lib/transcript-collate.ts`), out of the hot path. That rule is agent-neutral,
and it closed opencode's P8-004 transcript gap in P12-009.

## Historical import

`commands/import.ts` owns the shared auth, readiness, batching, upload, and summary
flow. Agent-specific discovery and synthesis live behind `lib/import-source.ts`:
Claude Code JSONL, Codex rollout JSONL, OpenCode's read-only SQLite store, and the
Pi/OMP session JSONL family. Imported events use deterministic IDs and original
timestamps so reruns deduplicate; imports must still walk skipped history to preserve
turn ordinals and cumulative token baselines. Never put prompt, response, or tool
content into event metadata. Transcript sources pass through the same client-side
redaction and compression as live uploads; temporary OpenCode JSONL is owner-only,
removed after upload, and stale staging is cleared on the next import or `purge-local`.

Endpoint resolution belongs in `lib/config.ts`: environment overrides persisted
configuration, which overrides localhost defaults. Resolve URLs at call/startup time,
not module import time, so daemon restarts and tests observe config changes.

## Two hard invariants

- **`hook <kind>` always exits 0.** A broken hook must never interrupt the host agent.
  `hook-entry.ts` swallows everything; errors go to the log file only. If you add a
  code path here, it cannot throw past the top level.
- **The hot path stays tiny.** `hook-entry` writes one row to the local SQLite queue
  (WAL mode) and exits. No network, no redaction, no parsing beyond what the write
  needs — the flusher and shipper do that work out-of-process.

  **The one exception is a *terminal* hook reading a side-channel file for token
  usage**, because that is the only place three agents' usage exists: codex's
  rollout JSONL, gemini's accumulator, and (P14-003) Claude Code's session
  transcript at Stop. Every one of them is behind a per-session byte cursor, so
  the read is proportional to what the agent appended since the last turn and not
  to the session — an uncursored read is O(n²) over a session and will blow the
  budget on a long one. The rule that stayed intact: **no tool-lifecycle hook
  reads a file.** `PreToolUse`/`PostToolUse` fire orders of magnitude more often
  than a terminal hook, and putting I/O there is not affordable at any cursor
  size. That is why a live tool event cannot carry turn linkage as it is
  captured — the linkage is only derivable from the transcript, and the
  transcript is only read at Stop.

  **P14-006 closed that gap without weakening the rule**, and how it did is worth
  copying rather than reinventing. It did not add a read to the tool hooks. It
  found that the linkage has a *natural key* already present on both sides:
  Claude Code's tool payloads carry `tool_use_id`, and the transcript repeats the
  same id on the `tool_use` block of the issuing turn. So the tool hook does what
  it was already doing (copy one payload field — `lib/payload.ts` promotes it
  onto the tool block), the Stop hook lists the ids off lines it was already
  parsing (`lib/claude-turns.ts`, `toolUseIdsOf`), and **ingest** joins them on
  `(session_id, tool_use_id)`. Measured cost of the Stop-side addition on a real
  323-turn transcript: 0.008 ms for the whole file. When a hook seems to need
  data it cannot afford to compute, look for a key both ends already spell the
  same way before you look for a heuristic — the alternative here was a
  timestamp-nearest-Stop guess that three separate reviews rejected, because its
  failure mode is a plausible dollar figure on the wrong tool.

## The perf budget, stated honestly

The design target is **<10 ms** added wall time on developer hardware
(`DESIGN_DOC`/`PLAN` Phase 1 exit criterion). `.github/workflows/perf.yml` benchmarks
cold start against a **<15 ms p99** budget — and it is **`continue-on-error: true`,
i.e. report-only**. On shared `ubuntu-latest` runners a Bun single-file-binary cold
start measures ~60–80 ms regardless of your code, so the number there is a trend line,
not a gate. Results upload as an artifact with 90-day retention.

**Do not treat a green perf job as proof you stayed in budget.** Run
`bun run --cwd apps/hook bench` locally on real hardware.

## Layout

```text
src/
  cli.ts           # entry; commands/ dispatch
  hook-entry.ts    # the <10ms hot path — stdin JSON → SQLite queue → exit 0
  flusher.ts       # long-running: drains queue, batches → POST /v1/events
  shipper.ts       # long-running: redacts + zstd + chunk-uploads transcripts
  adapters/        # per-agent capture (the seam)
  commands/        # login config install uninstall status pause resume purge import
  lib/             # queue, persisted config, import sources, adapters' shared parsing
```

**Adapter working state goes under `agentStateDir(<agent>)`** (`lib/paths.ts`) —
one root, so `purge-local` clears every agent's state without naming any of them.
Codex's rollout cursors, Gemini's token accumulators and Claude Code's per-session
transcript cursors all live there. Putting state
anywhere else means `purge` silently leaves it behind, which is how unredacted
per-session data survived a "delete all local telemetry data" once already.

## Building

`bun run build` compiles for the current platform; `build:all` cross-compiles all four
distribution targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) via
`bun build --compile --target bun-<os>-<arch>`. The output is a standalone executable —
no Bun or Node needed on the developer's machine. Binaries land in `dist/` at 50–80 MB
(the Bun runtime is bundled); Mac distribution beyond dev machines needs codesigning +
notarization (see `README.md`).
