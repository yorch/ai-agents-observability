# aiot hook binary

The `aiot` binary is a Bun-compiled CLI that installs as a Claude Code hook and ships telemetry to the observability platform.

## Building

```bash
# Current platform
bun run build

# All targets
bun run build:all

# Specific target
bun run build:darwin-arm64
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
  install       Write launchd/systemd service files and print the hook snippet
  uninstall     Remove service files (does not remove local data)

  import        Import historical Claude Code, Codex, OpenCode, Pi, or OMP sessions
  hook <kind>   Run a hook entrypoint (reads JSON from stdin)
  flusher       Drain the SQLite queue and POST batches to /v1/events (long-running)
  shipper       Watch for transcript files and upload them to /v1/transcripts (long-running)

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

# 3. Install background services and get the settings.json snippet
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
- Live queue depth (pending events)
- Last successful flush timestamp
- Last error message (if any)
- Whether the flusher and shipper services are running (macOS/Linux)

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

**This does not affect data already uploaded to the server.** Manage server-side data at `$AIOT_API/me/settings/privacy`.

### `install`

Writes background service files for the flusher and shipper, then loads/enables
them by default:

- **macOS**: `~/Library/LaunchAgents/com.brnby.aiot.{flusher,shipper}.plist`
- **Linux**: `~/.config/systemd/user/aiot-{flusher,shipper}.service`

Also prints the JSON snippet to paste into `~/.claude/settings.json`.

| Flag | Description |
|------|-------------|
| `--no-start` | Write the service files but don't load/enable them (prints the commands instead) |
| `--force` | Write service files even when running uncompiled (from the Bun runtime, not the binary) |

When run over an existing install, the services are unloaded/disabled first,
the files are rewritten, and then reloaded — so `install` is idempotent and
serves as the upgrade path after `install.sh` drops a new binary.

### `uninstall`

Removes the service files written by `install`. Does **not** remove local data (`purge-local` does that).

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

Hook kinds (Claude Code): `session-start`, `pre-tool-use`, `post-tool-use`, `stop`, `user-prompt-submit`, `pre-compact`, `subagent-stop`, `notification`.

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

Long-running daemon processes managed by launchd/systemd. The flusher drains the SQLite queue and POSTs event batches to `/v1/events`. The shipper watches for session transcript markers and uploads redacted transcripts to `/v1/transcripts`.

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
  queue.db            — SQLite queue of pending events
  ship-queue/         — JSON markers for pending transcript uploads
  identity.json       — Hook auth token + GitHub login
  flusher-state.json  — Last flush time, queue depth, last error (cache)
  hook.log            — Append-only structured JSON log
  paused              — Pause marker (presence = paused)
```

Persistent endpoint configuration is stored separately at
`${XDG_CONFIG_HOME:-~/.config}/aiot/config.json`; `purge-local` removes
telemetry state and identity but intentionally keeps server configuration.
