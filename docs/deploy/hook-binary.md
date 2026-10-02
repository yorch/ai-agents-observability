# Hook binary distribution

The `aiot` hook binary is distributed via GitHub Releases. Each release includes **eight** platform-specific binaries (a launcher + a runtime for each of four targets) and a `SHA256SUMS-hook` checksum file.

The split into a launcher and a runtime exists so that macOS Background Task Management (BTM) attributes background processes to our signature rather than Bun's. Without the launcher, Activity Monitor's "App Background Activity" shows "Jarred Sumner" (Bun's author) because BTM reads the code-signing identity of the executable backing each LaunchAgent. The launcher is a ~300 KB Rust binary that `execv`s the ~50–80 MB Bun-compiled runtime next to it; the user never interacts with the runtime directly.

| Binary | Size | Installed as | Purpose |
|--------|------|-------------|---------|
| `aiot-<target>` | ~300 KB | `~/.local/bin/aiot` | Rust launcher — execs the runtime |
| `aiot-runtime-<target>` | ~50–80 MB | `~/.local/bin/aiot-runtime` | Bun-compiled CLI (all commands) |

Installation is a two-step process handled by two separate installers:

| Step | Installer | What it does |
|------|-----------|-------------|
| **1. Binary acquisition** | `scripts/install.sh` (shell script) | Downloads both binaries, verifies checksums, and places them on your `PATH` |
| **2. Delivery setup** | `aiot install` (CLI subcommand) | Auto-wires hooks into detected agent harnesses and sets up how delivery runs: by default (`--mode resident`) it writes launchd/systemd service files and starts the background daemons; with `--mode on-demand` it registers no service (see [Install without a service](#install-without-a-service---mode-on-demand)) |

Step 1 gets the binaries onto your machine. Step 2 wires them into your coding agent's hook configuration and, in resident mode, your system services. Both are needed for a working install.

## Step 1 — Binary acquisition

### Option A: Install script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash
```

Or to install a specific version or to a system-wide directory:

```bash
curl -fsSL ... | bash -s -- --version v1.0.0
curl -fsSL ... | bash -s -- --prefix /usr/local/bin   # system-wide (requires sudo)
```

The default prefix is `~/.local/bin` — a user-writable directory that avoids `sudo` entirely. If it's not on your `PATH`, the script prints the `export PATH=` line to add to your shell profile. The subsequent `aiot install` command never needs sudo: it writes to user-owned directories only (`~/Library/LaunchAgents/`, `~/.config/systemd/user/`, `~/.claude/`, etc.).

> **Upgrading from a previous install?** If you previously installed to `/usr/local/bin` (the old default), re-running the script will install to `~/.local/bin` instead. The old binary will remain at `/usr/local/bin` until you remove it (`sudo rm /usr/local/bin/aiot /usr/local/bin/aiot-runtime`). Or pass `--prefix /usr/local/bin` to keep the old location.

**What the script does, in order:**

1. **Parses args** — `--version <tag>`, `--prefix <dir>` (default `~/.local/bin`); validates that values are present and don't start with `-`.
2. **Detects platform** — `uname -s` + `uname -m` → one of `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. Exits 1 on unsupported platforms.
3. **Resolves version** — if no `--version`, queries the GitHub API for the latest release tag.
4. **Downloads the binary** — prefers `gh release download` if `gh` is installed and authenticated, otherwise falls back to `curl`. Shows a progress bar for the 50–80 MB download.
5. **Fetches checksums** — downloads `SHA256SUMS-hook` from the same release. A 404 (asset not published for older releases) warns and continues; any other HTTP error or network failure **aborts** — the binary is not installed without verification.
6. **Verifies checksum** — uses `sha256sum` on Linux or `shasum -a 256` on macOS (strips CRLF from the checksums file first). Aborts on mismatch or if neither tool is available.
7. **Detects upgrades** — if an existing binary is at the install path, runs `--version` (with a 5s timeout) and reports the old version.
8. **Installs** — `mv` into the prefix, using `sudo` only if the prefix is not writable.
9. **Quarantine notice** — on macOS, if the binary has the `com.apple.quarantine` xattr, prints the `xattr -d` command to remove it.

### Option B: Manual download

1. Go to the [releases page](https://github.com/yorch/ai-agents-observability/releases).
2. Download **both** binaries for your platform:

| Launcher | Runtime | Platform |
|----------|---------|----------|
| `aiot-darwin-arm64` | `aiot-runtime-darwin-arm64` | macOS (Apple Silicon) |
| `aiot-darwin-x64` | `aiot-runtime-darwin-x64` | macOS (Intel) |
| `aiot-linux-x64` | `aiot-runtime-linux-x64` | Linux (x86-64) |
| `aiot-linux-arm64` | `aiot-runtime-linux-arm64` | Linux (ARM64) |

3. Download `SHA256SUMS-hook` from the same release.

### Option C: Via the GitHub CLI

```bash
TAG=v1.0.0   # replace with the tag you want
gh release download "${TAG}" --repo yorch/ai-agents-observability \
  --pattern "aiot-darwin-arm64" \
  --pattern "aiot-runtime-darwin-arm64" \
  --pattern "SHA256SUMS-hook"
```

### Verify (manual download)

```bash
sha256sum -c SHA256SUMS-hook --ignore-missing
```

Both binaries should report `OK`.

### Install manually (manual download)

Install both binaries to the same directory — the launcher finds the runtime by looking for `aiot-runtime` next to itself. The examples below use `~/.local/bin` (the default, no sudo needed). Use `/usr/local/bin` for a system-wide install (requires `sudo`).

**Mac:**

```bash
mkdir -p ~/.local/bin
chmod +x aiot-darwin-arm64 aiot-runtime-darwin-arm64
mv aiot-darwin-arm64 ~/.local/bin/aiot
mv aiot-runtime-darwin-arm64 ~/.local/bin/aiot-runtime
```

If the binary is unsigned (no Apple signing secrets were configured at build time), remove the quarantine attribute from both:

```bash
xattr -d com.apple.quarantine ~/.local/bin/aiot ~/.local/bin/aiot-runtime
```

Signed binaries (codesigned + notarized) do not need this step — Gatekeeper will accept them.

**Linux:**

```bash
mkdir -p ~/.local/bin
chmod +x aiot-linux-x64 aiot-runtime-linux-x64
mv aiot-linux-x64 ~/.local/bin/aiot
mv aiot-runtime-linux-x64 ~/.local/bin/aiot-runtime
```

## Step 2 — Delivery setup and hook wiring

Once the binary is on your `PATH`, run:

```bash
# Persist these first when the platform is not running on localhost.
aiot config set web-url https://observability.example.com
aiot config set ingest-url https://ingest.example.com

aiot login      # GitHub device-code OAuth flow
aiot install    # resident (default): launchd/systemd services + auto-wires detected agents
                # or: aiot install --mode on-demand  (no service; see below)
aiot status     # verify everything is healthy
```

**What `aiot install` does, in order:**

1. **Guards against uncompiled use** — if `process.execPath` is the Bun runtime (not the compiled binary), refuses to run. Service files would point at the wrong executable and agent hooks would be written as `bun hook <kind>`, which no agent can run. `--force --no-auto` writes the service files only (resident mode; with `--mode on-demand` it records the mode, writes nothing and wires no hooks); agent hooks are never wired from the Bun runtime.
2. **Records the mode and stops any running delivery process** — `--mode` if given, otherwise the mode already recorded (`resident` when none is). A running drainer, resident flusher or shipper, or `aiot import` holding the delivery lease is stopped first. In on-demand mode it also removes any resident service units left from an earlier install.
3. **Writes service files** (resident mode only; on-demand writes none):
   - **macOS**: `~/Library/LaunchAgents/com.brnby.aiot.{flusher,shipper}.plist` (launchd)
   - **Linux**: `~/.config/systemd/user/aiot-{flusher,shipper}.service` (systemd user units)
4. **Handles upgrades** — if service files already exist, unloads/disables them first, then rewrites and reloads. This makes `install` idempotent — re-running it after a binary upgrade restarts the daemons cleanly.
5. **Starts the services** (resident mode, default `--start`): runs `launchctl load` / `systemctl --user enable --now`. If any start step fails, exits 1 with a clear error. Use `--no-start` to write files without starting (prints the commands instead).
6. **Auto-detects and wires agent harnesses** — scans for installed agents (Claude Code, Codex, Gemini CLI, Copilot CLI, Pi, OMP, opencode) and automatically writes hook configuration into each detected agent's config. In interactive mode, shows a checkbox list of detected agents; use `--yes` to wire all without prompting. For shared config files, creates a `.aiot-backup` before first modification, preserves user-defined hooks, and strips only aiot-owned entries on re-install (idempotent). A symlinked config file (a dotfile manager) is updated through the link, which stays in place and whose target keeps its permissions; a target in a read-only location (a Nix store) makes the install fail with a message naming it. Writes are atomic but not locked: if the agent or you rewrite the same file at the same instant, the later write can drop the earlier one's change, and re-running `aiot install` repairs it. Agents that are not detected get their snippet printed for manual setup.

| Flag | Description |
|------|-------------|
| `--no-start` | Write service files but don't load/enable them (prints the commands instead) |
| `--force` | With `--no-auto`, write service files even when running uncompiled (from the Bun runtime, not the binary). Agent hooks are never wired from the Bun runtime, with or without `--force` |
| `--yes` | Wire all detected agents without prompting |
| `--agent <name>` | Wire only this agent (repeatable); skips detection and prompting |
| `--no-auto` | Skip auto-wiring entirely; print snippets for all agents (legacy behavior) |
| `--dry-run` | Show what would be wired without modifying any files |
| `--mode resident\|on-demand` | `resident` (default): launchd/systemd services. `on-demand`: no service units; a short-lived drainer runs after agent activity |

### Install without a service (`--mode on-demand`)

If you do not want a launchd/systemd service (on macOS it triggers a Login Items
prompt and a permanent background process), install in on-demand mode:

```bash
aiot install --mode on-demand
```

This wires the same agent hooks but writes **no service units** and runs no
`launchctl`/`systemctl`. After a Stop / SubagentStop / SessionEnd hook that queued
something (or a SessionStart, as catch-up), the hook starts a short-lived detached
`aiot drain`, which redacts and ships exactly what the resident services would.
Switching between modes (`--mode resident` / `--mode on-demand`) stops and removes
the other mode's units and any running drainer.

In short: nothing resident runs between agent sessions (a drainer can live up to
120 s after the last hook); data that could not be delivered waits on disk for the next
agent session (kept for 7 days); transcripts ship less often than in resident mode;
late events can miss PR linking; and a hard container teardown can lose the last
batch unless `aiot drain --wait` runs first. The exact rules, and the macOS note (the
MDM pre-approval idea is untested advice), are in
[`apps/hook/README.md`](../../apps/hook/README.md#install-modes).

`aiot status` in this mode shows the age of the oldest queued row, the last clean
drain, the current lease holder, and the queue depth (there is no heartbeat to go
stale).

**Containers and devcontainers.** Use on-demand mode with `AIOT_HOME` (and the config
directory) on a volume, a token from the environment, an explicit
`aiot config set ingest-url ...` (drainers ignore `INGEST_BASE_URL` from the
environment), and `aiot drain --wait` as the pre-stop step. The recipe, with the
reason for each line, is in
[`apps/hook/README.md`](../../apps/hook/README.md#drain).

After login, historical sessions can be previewed without uploading:

```bash
aiot import --agent codex --dry-run
# Also supported: claude-code, opencode, pi, omp
```

See [`apps/hook/README.md`](../../apps/hook/README.md) for the full CLI reference.

## Air-gapped distribution

For air-gapped environments, download both binaries and `SHA256SUMS-hook` on a connected machine, transfer via your approved mechanism, verify checksums on the target, and install manually as described in Step 1 Option B above. Then run Step 2 (`aiot install`) on the target machine.

## Updating

```bash
# Option A: re-run the install script (detects the upgrade, replaces both binaries)
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash

# Option B: manual
gh release download v1.1.0 --repo yorch/ai-agents-observability \
  --pattern "aiot-darwin-arm64" \
  --pattern "aiot-runtime-darwin-arm64" \
  --pattern "SHA256SUMS-hook"
sha256sum -c SHA256SUMS-hook --ignore-missing
chmod +x aiot-darwin-arm64 aiot-runtime-darwin-arm64
mv aiot-darwin-arm64 ~/.local/bin/aiot
mv aiot-runtime-darwin-arm64 ~/.local/bin/aiot-runtime
```

After replacing the binaries, re-run `aiot install` to restart the daemons with the new executable (resident mode). In on-demand mode there are no daemons to restart: the next drainer simply runs the new binary, and `install` only re-applies the hook wiring.

```bash
aiot install    # resident: unloads old services, rewrites files, reloads. on-demand: re-wires hooks only
aiot status     # verify: the mode line, and in resident mode that the daemons are running
```

`aiot install` without `--mode` **keeps the mode you installed in** (`resident` when none
is recorded). On an `--mode on-demand` install it therefore writes no service units and
starts no daemon — it only re-wires the hooks (and any newly installed agent) at the new
binary's path. To change mode, say so: `aiot install --mode resident` /
`--mode on-demand`.

The hook binary is stateless across versions — the local SQLite queue, identity, and service files are preserved.
