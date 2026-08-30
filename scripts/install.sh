#!/usr/bin/env bash
# Install the aiot hook binary from GitHub Releases.
# Detects the platform, downloads the latest release binary, verifies the
# checksum, and installs to /usr/local/bin/aiot.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash
#
# Or to install a specific version:
#   curl -fsSL ... | bash -s -- --version v1.0.0
#
# Or to install to a custom directory:
#   curl -fsSL ... | bash -s -- --prefix ~/.local/bin

set -euo pipefail

REPO="yorch/ai-agents-observability"
VERSION=""
PREFIX="/usr/local/bin"
INSTALL_NAME="aiot"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "--version requires a value" >&2; exit 1; }
      [[ -z "$2" ]] && { echo "--version must not be empty" >&2; exit 1; }
      [[ "$2" == -* ]] && { echo "--version must not start with '-'" >&2; exit 1; }
      VERSION="$2"; shift 2 ;;
    --prefix)
      [[ $# -ge 2 ]] || { echo "--prefix requires a value" >&2; exit 1; }
      PREFIX="$2"; shift 2 ;;
    --help)
      echo "Usage: $0 [--version <tag>] [--prefix <dir>]"
      echo "  --version  Specific release tag (default: latest)"
      echo "  --prefix   Install directory (default: /usr/local/bin)"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}-${ARCH}" in
  Darwin-arm64)   TARGET="darwin-arm64" ;;
  Darwin-x86_64)  TARGET="darwin-x64" ;;
  Linux-x86_64)   TARGET="linux-x64" ;;
  Linux-aarch64)  TARGET="linux-arm64" ;;
  *)
    echo "Unsupported platform: ${OS}-${ARCH}" >&2
    echo "Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64" >&2
    exit 1
    ;;
esac

echo "Detected platform: ${TARGET}"

# Determine version
if [[ -z "${VERSION}" ]]; then
  if ! VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"; then
    echo "Could not fetch latest release version from GitHub API." >&2
    exit 1
  fi
  if [[ -z "${VERSION}" ]]; then
    echo "Could not determine latest release version." >&2
    exit 1
  fi
fi

echo "Installing aiot ${VERSION} for ${TARGET}..."

# Create temp directory
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

LAUNCHER="aiot-${TARGET}"
RUNTIME="aiot-runtime-${TARGET}"
LAUNCHER_URL="https://github.com/${REPO}/releases/download/${VERSION}/${LAUNCHER}"
RUNTIME_URL="https://github.com/${REPO}/releases/download/${VERSION}/${RUNTIME}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS-hook"
CHECKSUMS_FILE="${TMPDIR}/SHA256SUMS-hook"

# Download both binaries. Prefer gh if it's installed AND authenticated (it
# respects API rate limits better), but fall back to plain curl — which is
# the realistic path for most users running curl|bash.
download_file() {
  local filename="$1" url="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh release download "${VERSION}" --repo "${REPO}" \
      --pattern "${filename}" \
      --dir "${TMPDIR}" 2>/dev/null || {
        rm -f "${TMPDIR}/${filename}"
        curl -fL --progress-bar "${url}" -o "${TMPDIR}/${filename}" || return 1
      }
  else
    curl -fL --progress-bar "${url}" -o "${TMPDIR}/${filename}" || return 1
  fi
}

echo "Downloading ${LAUNCHER} (launcher, ~100 KB)..."
download_file "${LAUNCHER}" "${LAUNCHER_URL}" || {
  echo "Failed to download ${LAUNCHER} from release ${VERSION}" >&2
  exit 1
}

echo "Downloading ${RUNTIME} (runtime, ~50–80 MB)..."
download_file "${RUNTIME}" "${RUNTIME_URL}" || {
  echo "Failed to download ${RUNTIME} from release ${VERSION}" >&2
  exit 1
}

# Fetch checksums via gh (if used) or separately via curl.
if [[ ! -f "${CHECKSUMS_FILE}" ]]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh release download "${VERSION}" --repo "${REPO}" \
      --pattern "SHA256SUMS-hook" \
      --dir "${TMPDIR}" 2>/dev/null || true
  fi
fi

# Fetch checksums separately so a fetch failure is distinguishable from
# "asset not published for this release". A 404 means the release didn't
# ship a SHA256SUMS-hook asset (older releases) — warn and continue. Any
# other failure (network error, 5xx, redirect not followed) is treated as
# a real problem: we refuse to install an unverified binary.
if [[ ! -f "${CHECKSUMS_FILE}" ]]; then
  HTTP_CODE="$(curl -sL -o "${CHECKSUMS_FILE}" -w "%{http_code}" "${CHECKSUMS_URL}" 2>/dev/null || true)"
  case "${HTTP_CODE}" in
    200) ;;
    404)
      rm -f "${CHECKSUMS_FILE}"
      echo "Warning: SHA256SUMS-hook not published for ${VERSION} — skipping checksum verification." >&2
      ;;
    000|"")
      rm -f "${CHECKSUMS_FILE}"
      echo "Network failure fetching SHA256SUMS-hook — refusing to install unverified binary." >&2
      exit 1
      ;;
    *)
      rm -f "${CHECKSUMS_FILE}"
      echo "Failed to fetch SHA256SUMS-hook (HTTP ${HTTP_CODE}) — refusing to install unverified binary." >&2
      exit 1
      ;;
  esac
fi

# Verify checksums for both binaries (portable: sha256sum on Linux, shasum on macOS)
if [[ -f "${CHECKSUMS_FILE}" ]]; then
  echo "Verifying checksums..."
  # Strip CRLF in case the checksums file was generated on Windows.
  CHECKSUMS_NORMALIZED="${TMPDIR}/SHA256SUMS-hook.unix"
  tr -d '\r' < "${CHECKSUMS_FILE}" > "${CHECKSUMS_NORMALIZED}"

  verify_one() {
    local filename="$1"
    local expected_line
    expected_line="$(grep -m1 "[[:space:]]${filename}\$" "${CHECKSUMS_NORMALIZED}" || grep -m1 "[[:space:]]\*${filename}\$" "${CHECKSUMS_NORMALIZED}" || true)"
    if [[ -z "${expected_line}" ]]; then
      echo "Checksum for ${filename} not found in SHA256SUMS-hook." >&2
      return 1
    fi
    local expected_hash
    expected_hash="$(echo "${expected_line}" | awk '{print $1}')"
    if command -v sha256sum >/dev/null 2>&1; then
      echo "${expected_hash}  ${TMPDIR}/${filename}" | sha256sum -c - || return 1
    elif command -v shasum >/dev/null 2>&1; then
      (cd "${TMPDIR}" && echo "${expected_hash}  ${filename}" | shasum -a 256 -c -) || return 1
    else
      echo "Neither sha256sum nor shasum is installed — cannot verify checksum." >&2
      return 2
    fi
  }

  verify_one "${LAUNCHER}" || exit 1
  verify_one "${RUNTIME}" || exit 1
  echo "Checksums OK."
fi

# Make both executable
chmod +x "${TMPDIR}/${LAUNCHER}" "${TMPDIR}/${RUNTIME}"

# Install both binaries to the prefix
mkdir -p "${PREFIX}"
LAUNCHER_PATH="${PREFIX}/${INSTALL_NAME}"
RUNTIME_PATH="${PREFIX}/${INSTALL_NAME}-runtime"

# Detect an existing install so we can report this as an upgrade rather
# than a silent overwrite. Use a timeout so a broken old binary can't hang
# the install, and capture stderr too (some binaries print version there).
if [[ -x "${LAUNCHER_PATH}" ]]; then
  if command -v timeout >/dev/null 2>&1; then
    OLD_VERSION="$(timeout 5s "${LAUNCHER_PATH}" --version 2>&1 | head -n1 || echo "unknown")"
  elif command -v gtimeout >/dev/null 2>&1; then
    OLD_VERSION="$(gtimeout 5s "${LAUNCHER_PATH}" --version 2>&1 | head -n1 || echo "unknown")"
  else
    OLD_VERSION="$("${LAUNCHER_PATH}" --version 2>&1 | head -n1 || echo "unknown")"
  fi
  [[ -z "${OLD_VERSION}" ]] && OLD_VERSION="unknown"
  echo "Upgrading existing install (was: ${OLD_VERSION})..."
fi

install_file() {
  local src="$1" dest="$2"
  if [[ -w "${PREFIX}" ]]; then
    mv "${src}" "${dest}"
  else
    echo "Installing to ${dest} (requires sudo)..."
    sudo mv "${src}" "${dest}"
  fi
}

install_file "${TMPDIR}/${LAUNCHER}" "${LAUNCHER_PATH}"
install_file "${TMPDIR}/${RUNTIME}" "${RUNTIME_PATH}"

echo ""
echo "Installed: ${LAUNCHER_PATH} (launcher)"
echo "          ${RUNTIME_PATH} (runtime)"
echo ""
echo "Next steps:"
echo "  aiot login      # authenticate via GitHub OAuth"
echo "  aiot install    # set up background services + hook snippet"
echo "  aiot status     # check health"
echo ""

# Mac quarantine warning — check both binaries
if [[ "${OS}" == "Darwin" ]]; then
  for f in "${LAUNCHER_PATH}" "${RUNTIME_PATH}"; do
    if xattr "${f}" 2>/dev/null | grep -q "com.apple.quarantine"; then
      echo "Note: macOS quarantine attribute detected on ${f}. If the binary is unsigned, run:"
      echo "  xattr -d com.apple.quarantine \"${f}\""
      echo ""
    fi
  done
fi
