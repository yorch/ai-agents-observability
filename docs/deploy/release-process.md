# Release process

This project uses a two-phase release process. The key invariant: **nothing reaches a registry without human approval of the version number.**

## How it works

```text
Push to main (feat/fix/perf/refactor)
        ↓
release.yml: prepare-release job
  → scripts/prepare-release.sh analyzes conventional commits since last tag
  → determines next version (semver: breaking → major, feat → minor, fix → patch)
  → updates root + workspace package.json versions and bun.lock
  → generates CHANGELOG.md entry
  → opens/updates "chore: release vX.Y.Z" PR
        ↓
Reviewer checks version number + changelog (last cheap checkpoint)
        ↓
Merge the release PR
        ↓
release.yml: publish-release job
  → re-runs all four quality gates (check, typecheck, build, test)
  → creates vX.Y.Z tag pinned to the merge commit
  → creates a draft GitHub Release with changelog notes
  → explicitly dispatches docker.yml, build-binaries.yml, and build-hook.yml
    at the version tag and waits for all three workflows
  → verifies every expected release asset
  → publishes the release only when it is complete
```

## Versioning

Versions follow [semver](https://semver.org/), derived from [conventional commits](https://conventionalcommits.org/):

| Commit type | Bump | Example |
|---|---|---|
| `feat!:` or `BREAKING CHANGE` | major | `feat(deploy)!: redesign Helm chart` |
| `feat:` | minor | `feat(ingest): add cost reconciliation` |
| `fix:`, `perf:`, `refactor:` | patch | `fix(hook): capture real tool durations` |
| `docs:`, `chore:`, `test:`, `ci:`, `fix(release):`, `fix(ci):` | none | `chore(tasks): close Phase 14` |

## Day-to-day

1. **Write conventional commits** — `feat:`, `fix:`, `refactor:`, etc. with optional scope.
2. **Push to main** — the `prepare-release` job opens a `chore: release vX.Y.Z` PR automatically.
3. **Review the PR** — check the synchronized versions in the root and every workspace `package.json`, the matching `bun.lock` update, and the changelog entries in `CHANGELOG.md`.
4. **Merge the PR** — this triggers `publish-release`, which verifies every package version matches the tag, runs quality gates, creates the tag and draft release, dispatches all artifact workflows, verifies their assets, and publishes the completed release.

## What gets published

On each release, `release.yml` explicitly dispatches three workflow definitions from `main`, passing the immutable `release_tag`, and waits for them to attach artifacts to the draft GitHub Release. Each workflow checks out and packages source from that tag:

| Workflow | Artifacts | Checksum file |
|---|---|---|
| `docker.yml` | OCI image tarballs, SBOMs | `SHA256SUMS-images` |
| `build-binaries.yml` | Server binaries (4 platforms), web tarball | `SHA256SUMS-binaries` |
| `build-hook.yml` | Hook binaries (4 platforms) | `SHA256SUMS-hook` |

Docker images are also pushed to GHCR (`ghcr.io/yorch/ai-agents-observability/<component>:<tag>`), signed with cosign, and given GitHub build-provenance attestations.

## Idempotence and failure handling

- **Re-running `prepare-release`** is safe — it updates the existing release PR if one is already open.
- **Re-running a completed automatic `publish-release`** is a no-op when the release is already published.
- **A manual repair deliberately rebuilds** — it moves the selected release back to draft, rebuilds and verifies every artifact without moving the tag, then republishes it without changing which release is marked latest.
- **An artifact failure leaves a draft** — the release stays hidden until every workflow succeeds and every expected asset is present.
- **Artifact workflows do not edit release notes** — `release.yml` exclusively owns the changelog-based release body.

## Repair an incomplete release

Use the manual workflow input when a tag and release already exist but artifacts are incomplete:

```bash
gh workflow run release.yml --ref main \
  -f tag=v1.1.0 \
  -f update_floating_tags=true
```

Set `update_floating_tags=true` only when repairing the current latest release; it updates the `1`, `1.0`, and `latest` image tags and marks the GitHub Release latest. Omit it when repairing an older release.

The repair run validates the existing tag and its synchronized package versions, moves the release back to draft, rebuilds and verifies every artifact at that tag, then republishes it. It never moves or recreates the tag.

## Files

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | The two-phase release workflow |
| `scripts/prepare-release.sh` | Conventional commits → version + changelog |
| `scripts/release-version.ts` | Set and validate synchronized package versions |
| `CHANGELOG.md` | Generated changelog (one entry per release) |
