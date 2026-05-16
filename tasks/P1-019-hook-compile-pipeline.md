---
id: P1-019
title: Bun compile pipeline + multi-target
phase: 1
workstream: D
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-020, P1-023]
estimate: M
---

## Goal

`apps/hook` builds to a single statically-compiled binary `claude-telemetry` for darwin-arm64, darwin-x64, linux-x64, and linux-arm64. CI produces the binaries; a release workflow can ship them.

## Context

- `PLAN.md` §1 commits to Bun-compiled binaries. Pin to Bun 1.3.13 (stable JS impl) — NOT the in-progress Rust rewrite branch.
- Mac codesigning is a known risk (`PLAN.md` §6) — explored here.
- Binary must be self-contained: no Bun runtime required on the user's machine.

## Acceptance criteria

- [ ] `apps/hook/src/cli.ts` is the entrypoint (minimal placeholder — full subcommands in P1-023).
- [ ] `apps/hook/package.json` `build` script runs `bun build --compile --target=bun-<triple> --outfile=dist/claude-telemetry-<triple>` for each target (Bun 1.3 `--target` accepts `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-x64-musl`, `bun-linux-arm64`, `bun-linux-arm64-musl`, `bun-windows-x64`).
- [ ] All four targets produce binaries under `apps/hook/dist/`: darwin-arm64, darwin-x64, linux-x64 (glibc), linux-arm64 (glibc). musl + windows tracked as stretch.
- [ ] Binaries run on a clean machine (no Bun/Node) and respond to `claude-telemetry --version`.
- [ ] CI workflow `.github/workflows/build-hook.yml` matrix-builds all four; uploads artifacts.
- [ ] Mac binary codesigning step is stubbed (env-gated): if `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID` env vars present, run `codesign` + notarization commands; otherwise log a warning and continue. Document in the README.
- [ ] Binary size kept below 100MB per target (record current size in README).

## Implementation notes

- Bun's `--compile` bundles the runtime; expect ~50–80 MB.
- For Mac, the binary needs the Hardened Runtime entitlement + notarization for distribution outside dev machines. Codesigning script template: `xcrun notarytool submit ... --wait`.
- Linux ARM64 may need cross-compilation from a Linux x64 runner; verify Bun support in CI.

## Files touched

- `apps/hook/src/cli.ts`
- `apps/hook/package.json`
- `apps/hook/scripts/build.ts`
- `apps/hook/scripts/codesign-mac.sh`
- `.github/workflows/build-hook.yml`
- `apps/hook/README.md`

## Out of scope

- Subcommand implementations (P1-020 through P1-023).
- Auto-update mechanism.
- Homebrew tap / .deb packaging.

## Verification

```bash
pnpm --filter=@app/hook build
./apps/hook/dist/claude-telemetry-darwin-arm64 --version  # or matching triple
# CI:
gh workflow run build-hook.yml
```
