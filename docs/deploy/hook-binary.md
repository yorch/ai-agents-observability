# Hook binary distribution

The `claude-telemetry` hook binary is distributed via GitHub Releases. Each release includes four platform-specific binaries and a `SHA256SUMS-hook` checksum file.

## Download

### From the GitHub Releases page

1. Go to the [releases page](https://github.com/yorch/ai-agents-observability/releases).
2. Download the binary for your platform:

| File | Platform |
|------|----------|
| `claude-telemetry-darwin-arm64` | macOS (Apple Silicon) |
| `claude-telemetry-darwin-x64` | macOS (Intel) |
| `claude-telemetry-linux-x64` | Linux (x86-64) |
| `claude-telemetry-linux-arm64` | Linux (ARM64) |

3. Download `SHA256SUMS-hook` from the same release.

### Via the CLI

```bash
TAG=v1.0.0   # replace with the tag you want
gh release download "${TAG}" --repo yorch/ai-agents-observability \
  --pattern "claude-telemetry-darwin-arm64" \
  --pattern "SHA256SUMS-hook"
```

### Via the install script

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install-hook.sh | bash
```

This detects your platform, downloads the latest release binary, verifies the checksum, and installs to `/usr/local/bin/claude-telemetry`.

## Verify

```bash
sha256sum -c SHA256SUMS-hook --ignore-missing
```

The binary you downloaded should report `OK`.

## Install

### Mac

```bash
chmod +x claude-telemetry-darwin-arm64
sudo mv claude-telemetry-darwin-arm64 /usr/local/bin/claude-telemetry
```

If the binary is unsigned (no Apple signing secrets were configured at build time), remove the quarantine attribute:

```bash
xattr -d com.apple.quarantine /usr/local/bin/claude-telemetry
```

Signed binaries (codesigned + notarized) do not need this step — Gatekeeper will accept them.

### Linux

```bash
chmod +x claude-telemetry-linux-x64
sudo mv claude-telemetry-linux-x64 /usr/local/bin/claude-telemetry
```

## Authenticate and install hooks

```bash
claude-telemetry login      # GitHub device-code OAuth flow
claude-telemetry install    # writes launchd/systemd services + prints hook snippet
claude-telemetry status     # verify everything is healthy
```

See [`apps/hook/README.md`](../../apps/hook/README.md) for the full CLI reference.

## Air-gapped distribution

For air-gapped environments, download the binary and `SHA256SUMS-hook` on a connected machine, transfer via your approved mechanism, verify checksums on the target, and install as above.

## Updating

```bash
# Download the new release, verify, and replace the binary
gh release download v1.1.0 --repo yorch/ai-agents-observability \
  --pattern "claude-telemetry-darwin-arm64" \
  --pattern "SHA256SUMS-hook"
sha256sum -c SHA256SUMS-hook --ignore-missing
chmod +x claude-telemetry-darwin-arm64
sudo mv claude-telemetry-darwin-arm64 /usr/local/bin/claude-telemetry
```

The hook binary is stateless across versions — the local SQLite queue, identity, and service files are preserved.
