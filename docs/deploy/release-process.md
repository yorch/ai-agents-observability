# Release process

This project uses a two-phase release process adapted from the [colophon release process](https://github.com/yorch/colophon). The key invariant: **nothing reaches a registry without human approval of the version number.**

## How it works

```text
Push to main (feat/fix/perf/refactor)
        ↓
release.yml: prepare-release job
  → scripts/prepare-release.sh analyzes conventional commits since last tag
  → determines next version (semver: breaking → major, feat → minor, fix → patch)
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
  → creates GitHub Release with changelog notes
        ↓
Tag push triggers artifact workflows:
  → docker.yml: Docker images + OCI bundle + SBOMs + cosign signing
  → build-binaries.yml: server binaries + web tarball
  → build-hook.yml: hook binaries
        ↓
All artifacts attached to the same GitHub Release
```

## Versioning

Versions follow [semver](https://semver.org/), derived from [conventional commits](https://conventionalcommits.org/):

| Commit type | Bump | Example |
|---|---|---|
| `feat!:` or `BREAKING CHANGE` | major | `feat(deploy)!: redesign Helm chart` |
| `feat:` | minor | `feat(ingest): add cost reconciliation` |
| `fix:`, `perf:`, `refactor:` | patch | `fix(hook): capture real tool durations` |
| `docs:`, `chore:`, `test:`, `ci:` | none | `chore(tasks): close Phase 14` |

## Day-to-day

1. **Write conventional commits** — `feat:`, `fix:`, `refactor:`, etc. with optional scope.
2. **Push to main** — the `prepare-release` job opens a `chore: release vX.Y.Z` PR automatically.
3. **Review the PR** — check the version number and changelog entries in `CHANGELOG.md`.
4. **Merge the PR** — this triggers `publish-release`, which runs quality gates, creates the tag, and creates the GitHub Release.
5. **Tag push triggers artifacts** — Docker images, server binaries, hook binaries, and web tarball are built and attached to the release.

## What gets published

On each release, three workflows fire on the `v*` tag push and attach artifacts to the same GitHub Release:

| Workflow | Artifacts | Checksum file |
|---|---|---|
| `docker.yml` | OCI image tarballs, SBOMs | `SHA256SUMS-images` |
| `build-binaries.yml` | Server binaries (4 platforms), web tarball | `SHA256SUMS-binaries` |
| `build-hook.yml` | Hook binaries (4 platforms) | `SHA256SUMS-hook` |

Docker images are also pushed to GHCR (`ghcr.io/yorch/ai-agents-observability/<component>:<tag>`), signed with cosign, and attested with SLSA provenance.

## Idempotence

- **Re-running `prepare-release`** is safe — it updates the existing release PR if one is already open.
- **Re-running `publish-release`** is safe — it checks if the tag and GitHub Release already exist before creating them.
- **Re-running the artifact workflows** is safe — they upload to the same GitHub Release (softprops/action-gh-release appends/updates).

## Manual override

If you need to create a release without the PR flow (e.g., an emergency fix):

```bash
# Run quality gates locally
bun run check && bun run typecheck && bun run build && bun run test

# Create and push the tag
git tag v1.0.1
git push origin v1.0.1
```

The tag push triggers the artifact workflows directly. You'll need to create the GitHub Release manually:

```bash
gh release create v1.0.1 --target <commit-sha> --title v1.0.1 --notes "..."
```

This bypasses the human-approval gate. Use sparingly.

## Files

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | The two-phase release workflow |
| `scripts/prepare-release.sh` | Conventional commits → version + changelog |
| `CHANGELOG.md` | Generated changelog (one entry per release) |
