# aiot hook binary

The `aiot` binary is a two-part executable: a Rust launcher (~300 KB) that `execv`s a Bun-compiled runtime (~50–80 MB). The launcher exists so that macOS Background Task Management attributes background processes to our code signature rather than Bun's. See [`docs/deploy/hook-binary.md`](../../docs/deploy/hook-binary.md) for the full distribution architecture.

## Building

Building requires both [Bun](https://bun.sh) and [Rust](https://rustup.rs) installed.

```bash
# Current platform (builds both launcher + runtime)
bun run build

# All targets (cross-compiles all four platforms)
bun run build:all

# Specific target
bun run build:darwin-arm64

# Build only the runtime (Bun binary, no launcher)
bun run build:runtime

# Build only the launcher (Rust binary, no runtime)
bun run build:launcher
```

## Targets

| Target | Runner |
|--------|--------|
| darwin-arm64 | Apple Silicon Mac |
| darwin-x64 | Intel Mac |
| linux-x64 | x86-64 Linux |
| linux-arm64 | ARM64 Linux |

Binary sizes are typically 50–80 MB (Bun runtime is bundled).

## Mac codesigning

Distribution outside developer machines requires Hardened Runtime + notarization.
Set `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_ID`, and `APPLE_APP_PASSWORD`
before running `scripts/codesign-mac.sh <binary>`.

Without these, the binary works on developer machines with `xattr -d com.apple.quarantine`.

## Usage

```
aiot <command> [options]

Commands:
  login         Authenticate with the observability server (device-code flow)
  config        Persist or show web and ingest service URLs
  status        Show auth status, queue depth, and service state
  pause         Pause telemetry collection (writes a marker file)
  resume        Resume telemetry collection (removes the marker)
  purge-local   Remove all local data (queue, logs, identity) — use --yes to confirm
  install       Wire hooks into detected agents and, by default (--mode resident), write
                launchd/systemd service files; --mode on-demand registers no service
  uninstall     Remove aiot hook config and any service files (does not remove local data)

  import        Import historical Claude Code, Codex, OpenCode, Pi, or OMP sessions
  hook <kind>   Run a hook entrypoint (reads JSON from stdin)
  drain         One delivery pass (events, then transcripts), then exit; --wait runs it in
                the foreground and exits non-zero if data remains
  flusher       Drain the SQLite queue and POST batches to /v1/events (long-running; resident mode)
  shipper       Watch for transcript files and upload them to /v1/transcripts (long-running; resident mode)

Options:
  --quiet        Suppress non-fatal output (errors still logged to file)
  -V, --version  Show version
  -h, --help     Show help
```

## Quickstart

```bash
# 1. For a remote deployment, persist its endpoints (localhost is the default)
aiot config set web-url https://observability.example.com
aiot config set ingest-url https://ingest.example.com

# 2. Authenticate (prints a URL + code to complete the GitHub device flow)
aiot login

# 3. Install background services and wire hooks into detected agents
#    (or `aiot install --mode on-demand` for no service at all — see "Install modes")
aiot install

# 4. Check everything looks healthy
aiot status
```

## Command reference

### `login`

Runs a GitHub device-code OAuth flow via the observability web app. Prompts you to visit a URL and enter a short code. On success, writes a hook token to `~/.aiot/identity.json`.

Uses the persisted `web-url`, defaulting to `http://localhost:3000`.
`AIOT_API` remains a higher-precedence override.

### `config`

Persists server endpoints in
`${XDG_CONFIG_HOME:-~/.config}/aiot/config.json`. The flusher and
shipper read this file at startup, so changing an endpoint does not require
reinstalling their launchd/systemd services.

```bash
aiot config show
aiot config path
aiot config set web-url https://observability.example.com
aiot config set ingest-url https://ingest.example.com
aiot config unset ingest-url
```

Environment variables take precedence over persisted values, which take
precedence over the localhost defaults.

### `status`

Prints:
- Logged-in user (from `identity.json`) or "not logged in"
- Whether telemetry is paused
- Install mode (`resident` or `on-demand`)
- Live queue depth (pending events)
- Last successful flush timestamp (resident mode)
- Last error message (if any)
- Whether the flusher and shipper services are running (resident mode, macOS/Linux)

In `on-demand` mode there is no daemon, so there is no heartbeat to go stale and
the heartbeat warning is not shown. Instead `status` reports what tells you
whether data is actually getting out: the **age of the oldest queued row** (a
stuck queue shows up as a growing number), transcripts still pending, the time of
the **last clean drain**, and the **current lease holder** (pid, role, age).

### `pause`

Writes `~/.aiot/paused`. All hook entrypoints check for this marker and exit 0 silently when present — no events are queued.

### `resume`

Deletes the `~/.aiot/paused` marker. Telemetry collection resumes on the next hook invocation.

### `purge-local`

Removes all local telemetry data. Requires `--yes` to confirm.

Removed paths:
- `~/.aiot/queue.db` (pending events)
- `~/.aiot/ship-queue/` (pending transcript markers)
- `~/.aiot/collated/` (staged transcript collations — **unredacted**; redaction runs during upload, so a collation left behind by a killed shipper is plaintext history)
- `~/.aiot/agent-state/` (per-agent working state: Codex rollout cursors, Gemini token accumulators, Claude Code transcript cursors)
- `~/.aiot/hook.log` (local log file)
- `~/.aiot/identity.json` (auth token)
- `~/.aiot/flusher-state.json` (flusher state cache)
- `~/.aiot/paused` (pause marker, if present)

In on-demand mode `purge-local` keeps the install mode by re-creating `queue.db` with only the mode in it. A crash between the delete and the re-create leaves no mode recorded, which reads as `resident`: run `aiot install --mode on-demand` again if hooks stop delivering.

**This does not affect data already uploaded to the server.** Manage server-side data at `$AIOT_API/me/settings/privacy`.

### `install`

Writes background service files for the flusher and shipper (`--mode resident`,
the default), or registers no service at all (`--mode on-demand`, see
[Install modes](#install-modes)), then loads/enables them by default:

- **macOS**: `~/Library/LaunchAgents/com.brnby.aiot.{flusher,shipper}.plist`
- **Linux**: `~/.config/systemd/user/aiot-{flusher,shipper}.service`

After the services are started (or, in on-demand mode, with none), `install` **auto-detects** installed agent harnesses
and wires aiot hooks into each one. For each detected agent:

- **Claude Code**: merges hook entries into `~/.claude/settings.json`
- **Gemini CLI**: merges hook entries into `~/.gemini/settings.json`
- **Codex CLI**: writes `~/.codex/hooks.json` (hooks path) or `~/.codex/aiot-notify.sh` + patches `config.toml` (notify path)
- **Copilot CLI**: writes `~/.copilot/hooks/aiot.json`
- **Pi**: writes `~/.pi/agent/extensions/telemetry.ts`
- **OMP**: writes `~/.omp/agent/hooks/telemetry.ts`
- **opencode**: writes `~/.config/opencode/plugin/telemetry.ts`

For shared config files (`settings.json`, `hooks.json`), aiot creates a
`.aiot-backup` copy before the first modification and preserves all
user-defined hooks. Repeated installs are idempotent — aiot strips its own
previous entries before appending the current ones, so no duplicates
accumulate. Agents that are not detected get their snippet printed for manual
setup.

Running `install` (in either mode, except `--dry-run`) also stops whatever currently holds the
delivery lease, so a running drainer, a resident flusher or shipper, or an
`aiot import` in progress is terminated first; re-run the import afterwards.

| Flag | Description |
|------|-------------|
| `--no-start` | Write the service files but don't load/enable them (prints the commands instead) |
| `--force` | With `--no-auto`, write service files even when running uncompiled (from the Bun runtime, not the binary). Agent hooks are never wired from the Bun runtime, with or without `--force` |
| `--yes` | Wire all detected agents without prompting |
| `--agent <name>` | Wire only this agent (repeatable); skips detection and prompting |
| `--no-auto` | Skip auto-wiring entirely; print snippets for all agents (legacy behavior) |
| `--dry-run` | Show what would be wired without modifying any files |
| `--mode resident\|on-demand` | `resident`: launchd/systemd services. `on-demand`: no service units, a short-lived drainer runs after agent activity. **Without the flag the recorded mode is kept** (`resident` when none is), so re-running `aiot install` after an upgrade never turns an on-demand install back into services |

When run over an existing install, the services are unloaded/disabled first,
the files are rewritten, and then reloaded — so `install` is idempotent and
serves as the upgrade path after `install.sh` drops a new binary. Hook config
is also re-applied idempotently.

### Install modes

**`resident`** (default) registers two always-on services (a flusher and a
shipper) with launchd/systemd. Data leaves the machine within seconds, whether or
not an agent is running.

**`on-demand`** is for developers who do not want a service — on macOS, a Login
Items prompt and a permanent background process. `aiot install --mode on-demand`
wires the agent hooks and writes **no launchd/systemd units** and runs no
`launchctl`/`systemctl`. Instead, after a Stop / SubagentStop / SessionEnd hook
that queued something (or a SessionStart, as catch-up for anything an earlier
session left behind), the hook starts a short-lived detached `aiot drain`. It
keeps everything resident mode keeps: client-side redaction, transcript shipping,
git/PR/team enrichment, resumable uploads. Switching modes stops and removes the
other mode's units and any running drainer, so the two never coexist.

What this costs, stated plainly:

- **Nothing resident runs between agent sessions.** Delivery is "near-live", not
  continuous: a drainer is started by a hook and exits when it is done, but it can
  stay alive for up to its **120 s cap** after the last hook. It exits as soon as
  nothing is due, on the first transport failure, with no token, or on a 401.
- **Undelivered data waits for the next agent session.** If you were offline, or
  closed the laptop, queued events and transcripts stay on disk (and keep their
  retry times) until the next hook starts a drainer. Rows older than 7 days are
  dropped, as in resident mode, and only while a usable token is present, so being
  logged out never turns into data loss. Connection errors (refused, DNS,
  unreachable) never count toward a row's 10-attempt cap, and a timeout counts
  only when ingest's `/health` answers, i.e. when the batch, not the network, is
  the likely culprit.
- **Late-delivered events can miss PR linking.** Enrichment (branch, PR number,
  CI/review state) is resolved on the first delivery attempt and then stored with
  the row, so a retry reuses it rather than re-resolving — but an event first
  delivered *after* its PR was merged is enriched against a lookup of **open** PRs
  and may not link.
- **Transcripts ship less often.** Each upload re-sends the whole redacted
  transcript, so in on-demand mode a session's transcript is uploaded on its first
  drain, at SessionEnd, at the first drain AFTER the session has been quiet for 5
  minutes, or when the last upload is more than 10 minutes old — not on every Stop.
  "The first drain after 5 quiet minutes" is not "5 minutes later": nothing runs
  to notice the quiet. A session that ends without a SessionEnd (Ctrl+C, a crash,
  an agent with no such hook) is therefore shipped by the NEXT session's catch-up
  drainer, possibly days later.
- **A hard container teardown can lose the final batch**, because nothing is left
  running to send it. Run `aiot drain --wait` first (see below).

macOS note: resident mode installs a LaunchAgent, which triggers the Login Items
approval prompt. On managed Macs an MDM login-items rule for the signed launcher may
be able to pre-approve it and so remove the prompt without giving up the always-on
behaviour. That is advice about how such rules generally work; it has not been
tested with this binary.

### `drain`

`aiot drain` is what the hook spawns. It makes **one pass**: flush queued events,
then ship pending transcripts, then exit — it never sleeps waiting for anything.
It stops at the first of: nothing due, a transport failure, no token, a 401, or a
120 s wall-clock cap. Whatever it could not deliver stays on disk with its retry
time. Run in the background it prints nothing (its stdio is `/dev/null`); look at
`aiot status` or `~/.aiot/hook.log`.

`aiot drain --wait` is the same pass in the foreground: it waits (up to the cap)
for a drainer that is already running, delivers the queued events, ships the
pending transcripts regardless of the on-demand cadence **if the transcripts lease
is free**, prints a summary, and **exits non-zero if any data remains**. If a
resident shipper or an `aiot import` holds the transcripts lease, the events are
still delivered, the transcripts are left to that holder, and the exit is 1 with
"transcripts remaining" in the summary. Use it for CI and devcontainer pre-stop
hooks, or to catch up by hand.

**Containers.** Keep `AIOT_HOME` on a volume so the queue survives the container,
authenticate through the environment, and drain before the container stops:

```bash
export AIOT_HOME=/workspace/.aiot          # a mounted volume
export AIOT_TOKEN=...                      # no interactive login in a container
aiot install --mode on-demand --yes
# ... agent sessions run; hooks queue data and spawn drainers ...
aiot drain --wait || echo "undelivered data remains in $AIOT_HOME"
```

Only one process does each kind of delivery work at a time. There are two leases
in `queue.db` (15 s TTL, renewed every 5 s, so a crashed holder frees it by
itself): `events` (the resident flusher) and `transcripts` (the resident shipper,
`aiot import`). `aiot drain` does both kinds of work (it needs `events` and takes
`transcripts` when it is free), so a long, throttled transcript sweep never holds up
event delivery in resident mode. A
resident service that cannot get its lease retries within seconds; `import` and
`drain --wait` wait for it. A holder that loses a lease (a suspend, a clock step)
aborts its in-flight requests at once. A drainer needs `events` and merely wants
`transcripts`: if a shipper or an import holds the latter it delivers the events and
leaves the transcripts to that holder, and `aiot import` runs one drain pass itself
when it finishes in on-demand mode.

The drainer is started with a **scrubbed environment**: an allowlist, not the
agent's shell. Passed on: `HOME`, `PATH`, `TMPDIR`, `AIOT_HOME`, `AIOT_CONFIG`,
`AIOT_TOKEN`, `XDG_CONFIG_HOME`, proxy and CA-bundle variables, and the user's GitHub
auth for PR/CI/review lookups (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_HOST`,
`GH_CONFIG_DIR`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`; not
`GITHUB_API_URL`, which names the host a token is sent to — `gh` finds a GitHub
Enterprise host through `GH_HOST` — plus `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`, which a keyring-backed `gh`
login needs on Linux). **Not** passed: `INGEST_BASE_URL`, `AIOT_QUEUE_*` and
anything else from the agent's shell — set the ingest URL with `aiot config set
ingest-url`. The trade-off: a GitHub token exported in the agent's shell for another
purpose changes whose identity enrichment resolves for that drain. (`aiot drain
--wait` run by hand keeps your shell's environment, as any command does.)

### `uninstall`

Removes the service files written by `install` (there are none in on-demand mode), stops a running
drainer, and strips aiot's hook entries from every agent config that was auto-wired. It resets the
install mode to `resident` *first*, so a hook it could not remove (a pasted snippet, project-level or
MDM-managed settings) cannot start another drainer. For shared config files, only
aiot-owned entries are removed — user-defined hooks are preserved. Backups
(`.aiot-backup`) are cleaned up after successful removal. Does **not** remove
local data (`purge-local` does that).

### `import`

Imports historical sessions from the selected agent's local data store, synthesizes
content-free telemetry events, and uploads client-redacted transcripts. Event IDs are
deterministic and the server also deduplicates them, so imports are safe to re-run.

```bash
# Claude Code is the default
aiot import --dry-run
aiot import --since 2026-01-01

# Other supported historical sources
aiot import --agent codex --dry-run
aiot import --agent opencode --since 2026-01-01
aiot import --agent pi
aiot import --agent omp

# One native or normalized session ID; events only
aiot import --agent codex --session <session-id> --no-transcripts
```

Requires authentication (`aiot login`) unless `--dry-run` is passed.

| Agent | Historical source |
|---|---|
| `claude-code` | `~/.claude/projects/**/*.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` |
| `opencode` | `~/.local/share/opencode/opencode.db` |
| `pi` | `~/.pi/agent/sessions/**/*.jsonl` |
| `omp` | `~/.omp/agent/sessions/**/*.jsonl` (also probes `~/.oh-omp`) |

| Flag | Description |
|------|-------------|
| `--agent <name>` | Select `claude-code`, `codex`, `opencode`, `pi`, or `omp` |
| `--since YYYY-MM-DD` | Skip events older than this date |
| `--session <id>` | Import only one native or normalized session ID |
| `--no-transcripts` | Skip transcript uploads |
| `--dry-run` | Parse + count without posting anything |
| `--quiet` | Suppress per-session progress output |

### `hook <kind>`

Low-level entrypoint invoked directly by the coding agent. Reads a JSON payload from stdin, converts it to an event, and appends it to the local SQLite queue. Should not be invoked manually.

Hook kinds (Claude Code): `session-start`, `session-end`, `pre-tool-use`, `post-tool-use`, `stop`, `user-prompt-submit`, `pre-compact`, `subagent-stop`, `notification`.

Hook entrypoints always exit 0 to avoid disrupting the agent — errors go to the log file only. This matters most for GitHub Copilot CLI, whose `preToolUse` hooks are fail-closed: a non-zero exit there denies the tool call.

### Supported agents

Pass `--agent <name>` to `install` (and to `hook <kind>`, which the generated snippet does for you). Each agent's hook kinds mirror its own event names; run `install --agent <name>` to print the config it needs.

| `--agent` | Agent | Wiring | Transcripts |
|---|---|---|---|
| `claude-code` (default) | Claude Code | `~/.claude/settings.json` hooks | yes |
| `codex` | OpenAI Codex CLI | `~/.codex/hooks.json` when `[features] hooks = true`, else the `notify` wrapper | yes |
| `gemini-cli` | Gemini CLI | `~/.gemini/settings.json` hooks | yes |
| `copilot` | GitHub Copilot CLI | `~/.copilot/hooks/*.json` | no (none exposed) |
| `pi` | Pi | `~/.pi/agent/extensions/telemetry.ts` | yes |
| `omp` | omp (oh-my-pi) | `~/.omp/agent/hooks/telemetry.ts` | yes |
| `opencode` | opencode | `~/.config/opencode/plugin/telemetry.ts` | yes (collated from its per-message storage) |

Codex's lifecycle hooks are experimental and off by default; `install --agent codex` detects whether they are enabled and prints the matching snippet either way.

If you already run the third-party `omp-hooks` plugin, omp can also be wired through Claude Code-style `settings.json` command hooks instead of the native module.

### `flusher` / `shipper`

Long-running daemon processes managed by launchd/systemd (resident mode only). The flusher drains the SQLite queue and POSTs event batches to `/v1/events`. The shipper watches for session transcript markers and uploads redacted transcripts to `/v1/transcripts`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (message written to stderr) |

Hook entrypoints (`hook <kind>`) always exit 0 regardless of errors — a broken hook must not interrupt Claude Code.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIOT_API` | persisted `web-url`, then `http://localhost:3000` | Highest-precedence web app URL override |
| `INGEST_BASE_URL` | persisted `ingest-url`, then `http://localhost:4000` | Highest-precedence ingest URL override |
| `AIOT_TOKEN` | the `token` in `identity.json` (from `aiot login`) | Auth token for processes started in the same environment — containers, `aiot import`, a foreground `aiot flusher`/`aiot shipper`. Wins over the file. The launchd/systemd services from `aiot install` do not inherit your shell's environment and still use `aiot login`. If ingest rejects it, `aiot login` cannot fix it; replace the variable |
| `AIOT_CONFIG` | `${XDG_CONFIG_HOME:-~/.config}/aiot/config.json` | Override the persisted config file path |
| `AIOT_HOME` | `~/.aiot` | Override the local data directory (useful for tests) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Override the Claude Code import source |
| `CODEX_HOME` | `~/.codex` | Override the Codex import source |
| `OPENCODE_DATA` | `${XDG_DATA_HOME:-~/.local/share}/opencode/storage` | Override the OpenCode storage root or database path |
| `PI_HOME` | `~/.pi` | Override the Pi import source |
| `OMP_HOME` | `~/.omp` / `~/.oh-omp` | Override the OMP import source |

## Local data layout

```
~/.aiot/
  queue.db            — SQLite queue of pending events, plus the install mode and delivery lease
  ship-queue/         — JSON markers for pending transcript uploads
  identity.json       — Hook auth token + GitHub login
  flusher-state.json  — Last flush time, queue depth, last error (cache)
  hook.log            — Append-only structured JSON log
  paused              — Pause marker (presence = paused)
```

Persistent endpoint configuration is stored separately at
`${XDG_CONFIG_HOME:-~/.config}/aiot/config.json`; `purge-local` removes
telemetry state and identity but intentionally keeps server configuration.
