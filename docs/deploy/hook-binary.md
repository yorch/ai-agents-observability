# Hook binary distribution

The `aiot` hook binary is distributed via GitHub Releases. Each release includes four platform-specific binaries and a `SHA256SUMS-hook` checksum file.

Installation is a two-step process handled by two separate installers:

| Step | Installer | What it does |
|------|-----------|-------------|
| **1. Binary acquisition** | `scripts/install.sh` (shell script) | Downloads, verifies, and places the compiled binary on your `PATH` |
| **2. Service setup** | `aiot install` (CLI subcommand) | Writes launchd/systemd service files, starts the background daemons, and prints the agent hook snippet |

Step 1 gets the binary onto your machine. Step 2 wires it into your system services and your coding agent's hook configuration. Both are needed for a working install.

## Step 1 — Binary acquisition

### Option A: Install script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash
```

Or to install a specific version or to a custom directory:

```bash
curl -fsSL ... | bash -s -- --version v1.0.0
curl -fsSL ... | bash -s -- --prefix ~/.local/bin
```

**What the script does, in order:**

1. **Parses args** — `--version <tag>`, `--prefix <dir>` (default `/usr/local/bin`); validates that values are present and don't start with `-`.
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
2. Download the binary for your platform:

| File | Platform |
|------|----------|
| `aiot-darwin-arm64` | macOS (Apple Silicon) |
| `aiot-darwin-x64` | macOS (Intel) |
| `aiot-linux-x64` | Linux (x86-64) |
| `aiot-linux-arm64` | Linux (ARM64) |

3. Download `SHA256SUMS-hook` from the same release.

### Option C: Via the GitHub CLI

```bash
TAG=v1.0.0   # replace with the tag you want
gh release download "${TAG}" --repo yorch/ai-agents-observability \
  --pattern "aiot-darwin-arm64" \
  --pattern "SHA256SUMS-hook"
```

### Verify (manual download)

```bash
sha256sum -c SHA256SUMS-hook --ignore-missing
```

The binary you downloaded should report `OK`.

### Install manually (manual download)

**Mac:**

```bash
chmod +x aiot-darwin-arm64
sudo mv aiot-darwin-arm64 /usr/local/bin/aiot
```

If the binary is unsigned (no Apple signing secrets were configured at build time), remove the quarantine attribute:

```bash
xattr -d com.apple.quarantine /usr/local/bin/aiot
```

Signed binaries (codesigned + notarized) do not need this step — Gatekeeper will accept them.

**Linux:**

```bash
chmod +x aiot-linux-x64
sudo mv aiot-linux-x64 /usr/local/bin/aiot
```

## Step 2 — Service setup and hook wiring

Once the binary is on your `PATH`, run:

```bash
# Persist these first when the platform is not running on localhost.
aiot config set web-url https://observability.example.com
aiot config set ingest-url https://ingest.example.com

aiot login      # GitHub device-code OAuth flow
aiot install    # writes launchd/systemd services + prints hook snippet
aiot status     # verify everything is healthy
```

**What `aiot install` does, in order:**

1. **Guards against uncompiled use** — if `process.execPath` is the Bun runtime (not the compiled binary), refuses to write service files unless `--force` is passed. This prevents generating services that point at the wrong executable.
2. **Writes service files:**
   - **macOS**: `~/Library/LaunchAgents/com.brnby.aiot.{flusher,shipper}.plist` (launchd)
   - **Linux**: `~/.config/systemd/user/aiot-{flusher,shipper}.service` (systemd user units)
3. **Handles upgrades** — if service files already exist, unloads/disables them first, then rewrites and reloads. This makes `install` idempotent — re-running it after a binary upgrade restarts the daemons cleanly.
4. **Starts the services** (default, `--start`): runs `launchctl load` / `systemctl --user enable --now`. If any start step fails, exits 1 with a clear error. Use `--no-start` to write files without starting (prints the commands instead).
5. **Prints the hook snippet** — the JSON/config to paste into your coding agent's settings (`~/.claude/settings.json` for Claude Code, `~/.codex/hooks.json` for Codex, etc.). Use `--agent <name>` to select a different agent's snippet.

| Flag | Description |
|------|-------------|
| `--no-start` | Write service files but don't load/enable them (prints the commands instead) |
| `--force` | Write service files even when running uncompiled (from the Bun runtime, not the binary) |
| `--agent <name>` | Select the agent whose hook snippet to print (default: `claude-code`) |

After login, historical sessions can be previewed without uploading:

```bash
aiot import --agent codex --dry-run
# Also supported: claude-code, opencode, pi, omp
```

See [`apps/hook/README.md`](../../apps/hook/README.md) for the full CLI reference.

## Air-gapped distribution

For air-gapped environments, download the binary and `SHA256SUMS-hook` on a connected machine, transfer via your approved mechanism, verify checksums on the target, and install manually as described in Step 1 Option B above. Then run Step 2 (`aiot install`) on the target machine.

## Updating

```bash
# Option A: re-run the install script (detects the upgrade, replaces the binary)
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash

# Option B: manual
gh release download v1.1.0 --repo yorch/ai-agents-observability \
  --pattern "aiot-darwin-arm64" \
  --pattern "SHA256SUMS-hook"
sha256sum -c SHA256SUMS-hook --ignore-missing
chmod +x aiot-darwin-arm64
sudo mv aiot-darwin-arm64 /usr/local/bin/aiot
```

After replacing the binary, re-run `aiot install` to restart the daemons with the new executable:

```bash
aiot install    # unloads old services, rewrites files, reloads
aiot status     # verify the daemons picked up the new binary
```

The hook binary is stateless across versions — the local SQLite queue, identity, and service files are preserved.
