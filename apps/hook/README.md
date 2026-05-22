# claude-telemetry hook binary

The `claude-telemetry` binary is a Bun-compiled CLI that installs as a Claude Code hook and ships telemetry to the observability platform.

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
claude-telemetry <command> [options]

Commands:
  login         Authenticate with the observability server (device-code flow)
  status        Show auth status, queue depth, and service state
  pause         Pause telemetry collection (writes a marker file)
  resume        Resume telemetry collection (removes the marker)
  purge-local   Remove all local data (queue, logs, identity) — use --yes to confirm
  install       Write launchd/systemd service files and print the hook snippet
  uninstall     Remove service files (does not remove local data)

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
# 1. Authenticate (opens browser for GitHub device-code flow)
claude-telemetry login

# 2. Install background services and get the settings.json snippet
claude-telemetry install

# 3. Check everything looks healthy
claude-telemetry status
```

## Command reference

### `login`

Runs a GitHub device-code OAuth flow via the observability web app. Prompts you to visit a URL and enter a short code. On success, writes a hook token to `~/.claude-telemetry/identity.json`.

Reads `CLAUDE_TELEMETRY_API` (default: `http://localhost:3000`).

### `status`

Prints:
- Logged-in user (from `identity.json`) or "not logged in"
- Whether telemetry is paused
- Live queue depth (pending events)
- Last successful flush timestamp
- Last error message (if any)
- Whether the flusher and shipper services are running (macOS/Linux)

### `pause`

Writes `~/.claude-telemetry/paused`. All hook entrypoints check for this marker and exit 0 silently when present — no events are queued.

### `resume`

Deletes the `~/.claude-telemetry/paused` marker. Telemetry collection resumes on the next hook invocation.

### `purge-local`

Removes all local telemetry data. Requires `--yes` to confirm.

Removed paths:
- `~/.claude-telemetry/queue.db` (pending events)
- `~/.claude-telemetry/ship-queue/` (pending transcript markers)
- `~/.claude-telemetry/hook.log` (local log file)
- `~/.claude-telemetry/identity.json` (auth token)
- `~/.claude-telemetry/flusher-state.json` (flusher state cache)
- `~/.claude-telemetry/paused` (pause marker, if present)

**This does not affect data already uploaded to the server.** Manage server-side data at `$CLAUDE_TELEMETRY_API/me/privacy`.

### `install`

Writes background service files for the flusher and shipper:

- **macOS**: `~/Library/LaunchAgents/com.claude-telemetry.{flusher,shipper}.plist`
- **Linux**: `~/.config/systemd/user/claude-telemetry-{flusher,shipper}.service`

Also prints the JSON snippet to paste into `~/.claude/settings.json`.

### `uninstall`

Removes the service files written by `install`. Does **not** remove local data (`purge-local` does that).

### `hook <kind>`

Low-level entrypoint invoked directly by Claude Code. Reads a JSON payload from stdin, converts it to an event, and appends it to the local SQLite queue. Should not be invoked manually.

Hook kinds: `session-start`, `pre-tool-use`, `post-tool-use`, `stop`, `user-prompt-submit`, `pre-compact`, `subagent-stop`, `notification`.

Hook entrypoints always exit 0 to avoid disrupting Claude Code — errors go to the log file only.

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
| `CLAUDE_TELEMETRY_API` | `http://localhost:3000` | Web app base URL (used by `login` and `purge-local`) |
| `INGEST_BASE_URL` | `http://localhost:4000` | Ingest API base URL (used by `flusher` and `shipper`) |
| `CLAUDE_TELEMETRY_HOME` | `~/.claude-telemetry` | Override the local data directory (useful for tests) |

## Local data layout

```
~/.claude-telemetry/
  queue.db            — SQLite queue of pending events
  ship-queue/         — JSON markers for pending transcript uploads
  identity.json       — Hook auth token + GitHub login
  flusher-state.json  — Last flush time, queue depth, last error (cache)
  hook.log            — Append-only structured JSON log
  paused              — Pause marker (presence = paused)
```
