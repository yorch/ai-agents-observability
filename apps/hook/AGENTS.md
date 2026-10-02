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

## Installing into agent configs: tests never touch the real HOME

`install` rewrites config files this tool does not own (`~/.claude/settings.json`,
`~/.codex/hooks.json`, the opencode/pi plugin files). Three rules, all from one
incident where `bun test` appended six hook groups per run to a developer's real
configs, written as `bun hook <kind>`, with the suite green:

- **Tests never touch the real HOME.** `bunfig.toml` preloads
  `test-setup/isolate-home.ts`, which points `HOME`/`AIOT_HOME` and `os.homedir()` at
  a temp dir. It also makes writes under the real home's `.claude`, `.codex`,
  `.config/opencode`, `.config/systemd`, `.pi`, `.gemini`, `.copilot`, `.omp`, `.aiot`
  and `Library/LaunchAgents` throw (symlinks resolved): node:fs mutators in sync,
  callback and promises form, write-mode `open`, `createWriteStream`, and `Bun.write`.
  **Not guarded:** `Bun.file().writer()`, bun:sqlite opening a file, and child
  processes such as `Bun.spawn` of an external tool; only the temp HOME/AIOT_HOME
  covers those. `bunfig.toml` is read from the CWD only, so run `bun test` from
  `apps/hook` or the repo root (whose bunfig points at the same preload); anywhere
  else is unguarded, and `test-isolation.test.ts` fails first with a clear message.
  That test only ever probes a fake protected dir exported by the preload. If it goes
  red, stop and fix the preload before running anything else. Adapters read
  `homeDir()` (HOME), not `runInstall`'s `homeDir` argument, so injecting that
  argument alone isolates nothing.
- **Hook wiring never writes a non-compiled binary.** `runInstall` refuses unless
  `process.execPath` is the compiled aiot binary (`isAiotBinary`: basename `aiot`,
  `aiot-<target>` or `aiot-runtime-<target>`, the same predicate ownership uses),
  `--force` or not (`--force --no-auto` writes service files only, and prints no
  snippets). Every adapter's `apply` runs behind that one check; tests inject the
  `exe` argument instead of weakening it.
- **Ownership is structural, not a substring.** `lib/config-wire.ts` matches the parsed
  entry (basename `aiot*` + `hook` arg). It also recognises the exact leaked legacy
  shapes so re-install and uninstall repair them: Claude
  `{args:['hook',<kind>], command:<absolute>/bun, type}` and Codex
  `{command:[<absolute>/bun,'hook',<kind>,'--agent',<name>], type}`, known kind, no
  matcher or extra keys. A plain `"bun hook stop"` string, a relative `bun`, an
  unknown kind or a customised entry is left alone. **Residual risk:** a developer's
  own absolute-path `bun hook <known-kind>` hook with nothing else on it is
  indistinguishable from the leak and will be treated as ours.
  `command.includes('aiot')` missed `bun` (every re-install appended a group) and
  matched foreign paths. Test with real-shaped entries, not a bin that happens to
  contain "aiot".

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
  (In on-demand mode a *terminal* hook also does a claim query on the open connection and
  a detached spawn — see "On-demand mode" below. A tool-lifecycle hook does neither.)

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
  flusher.ts       # flushOnce (one batch) + the resident loop that calls it
  shipper.ts       # shipPass (one sweep: redact + zstd + chunk-upload) + the resident loop
  adapters/        # per-agent capture (the seam)
  commands/        # login config install uninstall status pause resume purge import drain
  lib/             # queue (+ queue-schema, lease), persisted config, import sources, adapters' shared parsing
```

**Adapter working state goes under `agentStateDir(<agent>)`** (`lib/paths.ts`) —
one root, so `purge-local` clears every agent's state without naming any of them.
Codex's rollout cursors, Gemini's token accumulators and Claude Code's per-session
transcript cursors all live there. Putting state
anywhere else means `purge` silently leaves it behind, which is how unredacted
per-session data survived a "delete all local telemetry data" once already.

## On-demand mode (no resident service)

`aiot install --mode on-demand` registers no launchd/systemd unit. The hook starts a
short-lived detached `aiot drain` after a terminal event instead (`lib/drainer-spawn.ts`).
It must keep everything resident mode keeps; the rules below are what make that safe.
Each one is here because the obvious version of it is wrong.

- **Two leases, taken by everything that ships.** `lib/lease.ts` keeps one row per kind
  of delivery work in `queue.db` (`delivery_lease`): `events` (resident flusher) and
  `transcripts` (resident shipper, `aiot import`); `aiot drain` NEEDS `events` and WANTS
  `transcripts` (it asks again, `tryAdd`, once its events are done). They are separate so a
  long, throttled transcript sweep cannot hold up event delivery, and so a drainer can still
  deliver events while an import holds the transcripts — blocking a spawn on ANY lease
  stranded every hook that fired during an import. A spawn is refused only while `events`
  or a drainer is held.
  A crash frees a lease after the 15 s TTL — no flock, no pid file, and ownership is a
  random token so there is no PID-reuse hazard. A service that cannot get its lease
  **retries in seconds, never at its next sweep** (the resident shipper once skipped a whole
  10-minute sweep because the flusher held the lease for 100 ms). Expiry is wall-clock, so
  a lease claiming to outlive now + TTL is treated as expired (a clock that stepped back),
  and a holder whose clock stepped forward learns at its next renewal; losing a lease aborts
  `lease.signal`, which every fetch carries, and the chunk loop and the drain loop poll it.
  A synchronous `gh`/`git` call blocks the renewal timer, so a holder can overlap a
  successor for as long as one such call lasts (seconds, bounded by their timeouts).
- **Spawn rules.** Terminal events only (`Stop`, `SubagentStop`, `SessionEnd`,
  `SessionStart` — matched on event type, not kind string, so it is agent-neutral), and
  only with something enqueued or at SessionStart. Never from a tool-lifecycle hook,
  never while paused. The decision is made on the connection the hook already has open
  (`claimDrainerSpawn`: a read, then — only when it can win — one `UPDATE ... RETURNING`),
  which doubles as the dedupe: a burst of Stops starts one drainer. Do not add a `COUNT(*)`
  or a file read to the hook for this.
- **A drainer looks again before it lets go.** A hook that fires while a drainer runs sees a
  held lease and spawns nothing, so the drainer clears the spawn claim when it takes the
  lease, re-checks `hasDue()` and the shippable markers after each pass (inside the lease,
  bounded rounds), and once more after releasing it (a hook arriving after that finds the
  lease free and spawns its own). Without this a `/exit` seconds after the last answer —
  the commonest ending — left its SessionEnd and final transcript for the next session. Do
  not "fix" a test of this by resetting `spawn_claimed_until` or running `aiot drain` by hand.
  The two re-checks (inside the lease, after it) deliberately overlap — either alone covers a
  hook landing mid-pass — and the code says so; keep both. A drainer that never took a lease
  (busy, dead on SQLITE_BUSY, rejected token) hands the claim back in `finally`, or every hook
  inside the 10 s window is stranded. `aiot import` in on-demand mode runs one drain pass
  when it finishes, for the transcripts a hook's drainer had to leave to it.
- **The drainer's environment is an allowlist** (`drainerEnv`) with one rule: what says
  WHERE delivery goes must not come from the agent's shell (`INGEST_BASE_URL`,
  `AIOT_QUEUE_*`: a shell with `INGEST_BASE_URL=localhost` for another project would
  redirect every session on the machine); what says WHO the user is to GitHub may
  (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN`, and `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` for a
  keyring-backed `gh` login). Dropping those silently disabled enrichment in the container
  recipe the docs recommend. The accepted cost: a token exported in the agent's shell for
  something else decides whose identity that drain resolves. `GH_HOST` stays although it
  is a host: with the enterprise tokens also passed, `gh api user` sends that token to
  whatever host the agent's shell names — accepted, since whoever controls the agent's
  environment already controls the agent. `GITHUB_API_URL` is NOT on the
  list: it names the host a token is sent to, an env-supplied host is exactly what must not
  receive one, and `gh` reaches a GitHub Enterprise host through `GH_HOST` anyway.
- **`aiot drain` never sleeps** waiting for anything. It ends on nothing due, first transport
  failure, no token, a rejected token, 401, or the 120 s cap. Failure state lives on disk
  (`next_attempt_at` on queue rows and ship markers; the rejected token's fingerprint and
  time and the consecutive-failure streak in `drain_state`), because the next drainer has no
  memory: the streak is what makes the backoff GROW across processes (≈1 s, 2 s, 4 s ... 5 min)
  instead of restarting at 1 s. An abort WE cause (cap, lost lease) is reported as `cap` /
  `lease_lost`, writes no "Network error" state and defers nothing. `last_drain_ok_at` is
  recorded only when no row or marker is held back by a retry time and no shippable
  marker was left to another process. A pass that ends `transport`, `no_token` or
  `unauthorized` also HOLDS spawns for max(30 s, the backoff) (`spawn_hold_until`; capped
  at 5 min; a SessionEnd bypasses it, the 10 s burst dedupe it does not): the row retry time
  only holds back rows that already failed, and each Stop adds a new due row. A 2xx in drain
  mode makes every deferred row and marker due at once, so the recovered drainer delivers
  the backlog in the same pass; a pass that was merely idle resets nothing. Only a real server response
  counts toward `MAX_ATTEMPTS`. A drainer prunes 7-day-old rows only while it has a usable
  token, like the resident flusher.
- **Enrich once, but only once it worked.** `flushOnce` writes enrichment back to the queue
  row and marks it `enriched = 1` only when every GitHub lookup ANSWERED
  (`lib/lookup-status.ts`: the resolvers return null for both "none" and "could not ask").
  Offline, `gh` and delivery fail together, and a null stored then would be permanent.
  An enriched row is never re-resolved (a merged PR must not change on retry).
- **Transcript cadence.** `shipPass({ mode: 'drain' })` ships a session at SessionEnd
  (`final`), at the first drain after its marker went quiet for 5 min, or when
  `last_shipped_at` is over 10 min old, and keeps the marker clean (`dirty: false`)
  afterwards so that memory survives. Nothing runs to notice the quiet, so a session that
  ends without SessionEnd ships at the NEXT session's catch-up drain. Every hook write —
  including `markShipFinal` — stamps `updated_at`; a chunk-progress write never changes it
  and never overwrites a newer hook write.
- **Uninstall switches spawning off first.** `aiot uninstall` writes mode `resident` before it
  stops the running drainer, so a hook the remover missed (pasted snippet, project-level or
  MDM-managed settings) cannot start the next one. `install --mode on-demand` records the
  mode BEFORE removing the resident units: if it cannot be recorded, the daemons are intact.
- **Schema changes go through `lib/queue-schema.ts`** (`ensureSchema`): one `PRAGMA
  user_version` read in the steady state, and every CREATE/ALTER inside one IMMEDIATE
  transaction on first contact. A hook meeting a legacy queue.db during that one-time upgrade
  waits on the lock instead of failing on a half-built schema.
- **Test it as real processes against the compiled binary** (`lib/e2e-harness.ts`,
  `on-demand.e2e.test.ts`). Under `bun test`, `process.execPath` is `bun`, where
  `bun drain` silently does nothing and a spawn test passes while spawning nothing
  (`isCompiledBinary()` guards the spawn for the same reason). Lease tests use real
  child processes too: one process, one SQLite connection and one event loop cannot
  race. A test that "forces" contention must prove the overlap happened (a drainer
  provably mid-upload when the shipper starts), and one that counts processes must count
  processes (`drain.done` lines), not rows of a single-row table. Tests must set `HOME`
  and `AIOT_HOME` to a temp dir and never edit an agent's real config.

### Resident mode: what changed

Everything not listed here behaves as it did before the on-demand work. This is the
complete list; if you add a difference, add a row.

| Area | Before | Now |
|---|---|---|
| Delivery coordination | none | flusher takes the `events` lease per batch, shipper the `transcripts` lease per sweep. Separate rows, so neither blocks the other; contention only with a drainer or `aiot import`, and then a retry within 5 s |
| Idle / no-token tick | a full-batch `drain(100)` read each tick | one `hasDue(false)` read; a tick with no token logs `flusher.no_token`, writes state and sleeps **without** touching the lease |
| Enrichment | in memory, discarded | written back to the row before the POST (one extra UPDATE per fresh batch); the row is marked final only when every lookup answered |
| Row retry time (`next_attempt_at`) | did not exist | **not honoured** by the flusher (`drain(n, false)`); only drainers read it |
| Marker retry time | did not exist | written on 404/409/429/401/network holds and by `recordRetryableFailure` on 5xx / collate / read failures; **not honoured** by the shipper |
| Shipper sweep | tries every marker; stops only at a 401 | unchanged |
| Marker bookkeeping | `body_hash` compared to detect a rewrite (wrong for multi-chunk) | `updated_at`, stamped by every hook write; progress and failure writes skip a marker the hook has rewritten |
| Batch of only undecodable rows | counted as a send (reset the failure counters) | dropped; resets nothing, loop continues |
| Per terminal hook | one INSERT | + one read of `drain_state` (the claim check; it matches nothing outside on-demand mode) |
| `queue.db` | two columns fewer, no `drain_state`/`delivery_lease` | upgraded in place on first open (versioned, one transaction) |
| `aiot status` | no `mode:` line | `mode: resident` line; opening the queue now migrates the schema (`openQueueReader` -> `ensureSchema`), so `status` can write on first run after an upgrade |
| `aiot install` (resident) | wrote units, touched no process | records the mode (creating `queue.db` if absent) and SIGTERMs, then SIGKILLs, any live lease holder first: a resident flusher or shipper mid-batch, a running `aiot import`. Re-running it without `--mode` keeps an on-demand install on-demand |
| SessionEnd | nothing on the marker for Claude Code | `markShipFinal` rewrites the marker and bumps `updated_at`, so an in-flight resident upload is "superseded" and costs one re-upload at the next sweep |
| `aiot import` | waited for no one | takes the `transcripts` lease and fails after a 150 s wait if a resident shipper sweep (or a drainer) holds it longer; stops its in-flight POSTs when the lease is lost |
| Resident shipper that loses its lease mid-upload | n/a | the pass ends `cap` and the daemon sleeps the full 10-minute sweep interval before looking again |
| `purge-local` | deleted the queue | stops any lease holder first; with on-demand recorded it recreates `queue.db` holding only the mode (a crash between the delete and the recreate silently reverts to resident). An IDLE resident daemon holds no lease, so there is nothing to stop: the flusher and shipper compare `queueFileId()` (dev:ino) to the file they opened and reopen the new `queue.db` (the flusher idles while it is missing) |

## Building

`bun run build` compiles both parts for the current platform; `build:all` cross-compiles
all four distribution targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`).
Each target produces two binaries:

- `aiot-<target>` — a ~300 KB Rust launcher (`launcher/`) that `execv`s the runtime.
  macOS BTM reads this binary's code signature for the "Developer Name" shown in
  Login Items & Extensions. Without it, BTM attributes the background activity to
  Bun's author ("Jarred Sumner") instead of our tool.
- `aiot-runtime-<target>` — the Bun-compiled CLI (`bun build --compile --target bun-<os>-<arch>`),
  50–80 MB (the Bun runtime is bundled).

The launcher finds `aiot-runtime` by looking for it next to itself in the same directory.
`lib/binary-path.ts:resolvedBinaryPath()` derives the launcher path from `process.execPath` (which
is the runtime) by stripping the `-runtime` suffix — service files and hook snippets point
at the launcher, not the runtime. Mac distribution beyond dev machines needs codesigning +
notarization of the launcher (see `README.md`).
