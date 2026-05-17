# claude-telemetry hook binary

The `claude-telemetry` binary is a Bun-compiled CLI that installs as a Claude Code hook.

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
claude-telemetry --version
claude-telemetry --help
```
