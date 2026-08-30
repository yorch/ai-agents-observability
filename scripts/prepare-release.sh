#!/usr/bin/env bash
# Generate the next version number and a changelog section from conventional
# commits since the last tag. Used by .github/workflows/release.yml to prepare
# the "chore: release vX.Y.Z" PR.
#
# Outputs two lines to stdout:
#   1. The next version (e.g. "0.1.0")
#   2. The changelog section body (markdown, without the version heading)
#
# Versioning (semver):
#   - BREAKING CHANGE footer or !: suffix  → major bump
#   - feat: / feat(scope):                 → minor bump
#   - fix: / perf: / refactor:             → patch bump
#   - docs: / chore: / test: / ci: / style: → no bump (skip)
#
# If there are no unreleased feat/fix/perf/refactor commits, exits with code 1
# (nothing to release).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Find the last version tag. If none, start from the first commit.
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

# Read the current version from package.json. This is authoritative: the
# release PR sets it via release-version.ts, and it survives a failed publish
# (the git tag does not). When the last tag's version is behind package.json,
# a previous publish failed — we start the changelog range from the
# "chore: release v{CURRENT}" merge commit so commits already in that
# release's changelog are not duplicated.
PKG_VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' package.json \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' \
  | head -1 \
  || echo "")

if [[ -n "${LAST_TAG}" ]]; then
  LAST_TAG_VERSION=$(echo "${LAST_TAG}" | sed -E 's/^v//')
else
  LAST_TAG_VERSION=""
fi

# Determine the current version and the changelog range start.
if [[ -n "${PKG_VERSION}" && "${PKG_VERSION}" != "0.0.0" ]]; then
  CURRENT="${PKG_VERSION}"
else
  # No package.json version — fall back to last tag or 0.0.0.
  CURRENT="${LAST_TAG_VERSION:-0.0.0}"
fi

# Determine the commit range for changelog and bump detection.
if [[ -n "${LAST_TAG}" && "${LAST_TAG_VERSION}" == "${CURRENT}" ]]; then
  # Normal case: last tag matches package.json — range is tag..HEAD.
  RANGE="${LAST_TAG}..HEAD"
  START_COMMIT="${LAST_TAG}"
elif [[ -n "${PKG_VERSION}" && "${PKG_VERSION}" != "0.0.0" && -n "${LAST_TAG}" && "${LAST_TAG_VERSION}" != "${CURRENT}" ]]; then
  # Failed publish: last tag is behind package.json. Find the
  # "chore: release v{CURRENT}" squash-merge commit on main and start
  # the range from there, excluding commits already in the previous
  # release's changelog.
  RELEASE_COMMIT=$(git log --grep="chore: release v${CURRENT}" --format='%H' --no-merges --max-count=1 2>/dev/null || echo "")
  if [[ -n "${RELEASE_COMMIT}" ]]; then
    RANGE="${RELEASE_COMMIT}..HEAD"
    START_COMMIT="${RELEASE_COMMIT}"
  else
    # Fallback: can't find the release commit — use last tag (may
    # duplicate some changelog entries, but better than skipping).
    RANGE="${LAST_TAG}..HEAD"
    START_COMMIT="${LAST_TAG}"
  fi
elif [[ -z "${LAST_TAG}" ]]; then
  # No tags at all — start from the first commit.
  RANGE=""
  START_COMMIT=$(git rev-list --max-parents=0 HEAD | tail -1)
else
  # No package.json version — use last tag.
  RANGE="${LAST_TAG}..HEAD"
  START_COMMIT="${LAST_TAG}"
fi

# Collect conventional commit subjects in the determined range.
# Format: <type>:<subject>  or  <type>(<scope>):<subject>
# Skip merge commits and chore/docs/test/ci/style commits for bump detection,
# but include all in the changelog.
if [[ -n "${RANGE}" ]]; then
  COMMITS=$(git log --format='%s' "${RANGE}" --no-merges)
else
  COMMITS=$(git log --format='%s' "${START_COMMIT}"..HEAD --no-merges)
fi

if [[ -z "${COMMITS}" ]]; then
  echo "No commits since ${START_COMMIT:-the beginning}" >&2
  exit 1
fi

# ── Determine version bump ───────────────────────────────────────────────────
HAS_BREAKING=0
HAS_FEAT=0
HAS_FIX=0

while IFS= read -r subject; do
  [[ -z "${subject}" ]] && continue

  # Check for breaking change indicator: "!:" or "BREAKING CHANGE" in the body
  if [[ "${subject}" =~ !: ]] || echo "${subject}" | grep -qi 'BREAKING[[:space:]]*CHANGE'; then
    HAS_BREAKING=1
  fi

  type=$(echo "${subject}" | sed -E 's/^([a-z]+)(\(.+\))?!?:.*/\1/')
  scope=$(echo "${subject}" | sed -E 's/^[a-z]+\(([^)]+)\)!?:.*/\1/')

  if [[ "${type}" == "fix" ]] && [[ "${scope}" == "release" || "${scope}" == "ci" ]]; then
    continue
  fi

  case "${type}" in
    feat)    HAS_FEAT=1 ;;
    fix|perf|refactor) HAS_FIX=1 ;;
  esac
done <<< "${COMMITS}"

MAJOR=$(echo "${CURRENT}" | cut -d. -f1)
MINOR=$(echo "${CURRENT}" | cut -d. -f2)
PATCH=$(echo "${CURRENT}" | cut -d. -f3)

if [[ "${HAS_BREAKING}" -eq 1 ]]; then
  MAJOR=$((MAJOR + 1))
  MINOR=0
  PATCH=0
elif [[ "${HAS_FEAT}" -eq 1 ]]; then
  MINOR=$((MINOR + 1))
  PATCH=0
elif [[ "${HAS_FIX}" -eq 1 ]]; then
  PATCH=$((PATCH + 1))
else
  echo "No releasable commits (feat/fix/perf/refactor) since ${START_COMMIT:-the beginning}" >&2
  exit 1
fi

NEXT_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# ── Generate changelog body ──────────────────────────────────────────────────
# Group commits by type, deduplicate, and format as markdown.
TODAY=$(date +%Y-%m-%d)

# Collect breaking changes
BREAKING_NOTES=""
FEAT_NOTES=""
FIX_NOTES=""
OTHER_NOTES=""

while IFS= read -r subject; do
  [[ -z "${subject}" ]] && continue

  type=$(echo "${subject}" | sed -E 's/^([a-z]+)(\(.+\))?!?:.*/\1/')
  scope=$(echo "${subject}" | sed -E 's/^[a-z]+\(([^)]+)\)!?:.*/\1/')

  # Skip CI/infra-only fix commits — they don't affect users.
  # Scopes: release, ci, build (when only touching .github/workflows)
  if [[ "${type}" == "fix" ]] && [[ "${scope}" == "release" || "${scope}" == "ci" ]]; then
    continue
  fi

  # Strip the conventional-commit prefix for display, keep the scope if present.
  # "feat(deploy): add Helm chart" → "deploy: add Helm chart"
  # "feat!: breaking change" → "breaking change"
  display=$(echo "${subject}" | sed -E 's/^[a-z]+(\(([^)]+)\))?!?: /\2: /' | sed -E 's/^: //')

  if [[ "${subject}" =~ !: ]] || echo "${subject}" | grep -qi 'BREAKING[[:space:]]*CHANGE'; then
    BREAKING_NOTES="${BREAKING_NOTES}- ${display}\n"
  elif [[ "${type}" == "feat" ]]; then
    FEAT_NOTES="${FEAT_NOTES}- ${display}\n"
  elif [[ "${type}" == "fix" ]]; then
    FIX_NOTES="${FIX_NOTES}- ${display}\n"
  elif [[ "${type}" == "perf" || "${type}" == "refactor" ]]; then
    OTHER_NOTES="${OTHER_NOTES}- ${display}\n"
  fi
done <<< "${COMMITS}"

# Assemble the changelog body
BODY=""

if [[ -n "${BREAKING_NOTES}" ]]; then
  BODY="${BODY}### Breaking Changes\n\n${BREAKING_NOTES}\n"
fi
if [[ -n "${FEAT_NOTES}" ]]; then
  BODY="${BODY}### Features\n\n${FEAT_NOTES}\n"
fi
if [[ -n "${FIX_NOTES}" ]]; then
  BODY="${BODY}### Bug Fixes\n\n${FIX_NOTES}\n"
fi
if [[ -n "${OTHER_NOTES}" ]]; then
  BODY="${BODY}### Performance / Refactors\n\n${OTHER_NOTES}\n"
fi

# Clean up trailing whitespace and extra newlines
BODY=$(echo -e "${BODY}" | sed '/^$/N;/^\n$/D')

# Output: version on line 1, changelog body on the rest
echo "${NEXT_VERSION}"
echo "${BODY}"
