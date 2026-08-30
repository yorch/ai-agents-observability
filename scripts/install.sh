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

BINARY="aiot-${TARGET}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS-hook"
CHECKSUMS_FILE="${TMPDIR}/SHA256SUMS-hook"

# Download the binary. Prefer gh if it's installed AND authenticated (it
# respects API rate limits better), but fall back to plain curl — which is
# the realistic path for most users running curl|bash.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "Downloading ${BINARY} via gh..."
  gh release download "${VERSION}" --repo "${REPO}" \
    --pattern "${BINARY}" \
    --pattern "SHA256SUMS-hook" \
    --dir "${TMPDIR}" 2>/dev/null || {
      # gh may have left partial files — clean them before the curl fallback.
      rm -f "${TMPDIR}/${BINARY}" "${CHECKSUMS_FILE}"
      echo "gh download failed, falling back to curl..." >&2
      curl -fL --progress-bar "${DOWNLOAD_URL}" -o "${TMPDIR}/${BINARY}" || {
        echo "Failed to download ${BINARY} from release ${VERSION}" >&2
        exit 1
      }
    }
else
  echo "Downloading ${BINARY}..."
  curl -fL --progress-bar "${DOWNLOAD_URL}" -o "${TMPDIR}/${BINARY}" || {
    echo "Failed to download ${BINARY} from release ${VERSION}" >&2
    exit 1
  }
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

# Verify checksum (portable: sha256sum on Linux, shasum -a 256 on macOS)
if [[ -f "${CHECKSUMS_FILE}" ]]; then
  echo "Verifying checksum..."
  # Strip CRLF in case the checksums file was generated on Windows.
  CHECKSUMS_NORMALIZED="${TMPDIR}/SHA256SUMS-hook.unix"
  tr -d '\r' < "${CHECKSUMS_FILE}" > "${CHECKSUMS_NORMALIZED}"
  EXPECTED_LINE="$(grep -m1 "[[:space:]]${BINARY}\$" "${CHECKSUMS_NORMALIZED}" || grep -m1 "[[:space:]]\*${BINARY}\$" "${CHECKSUMS_NORMALIZED}" || true)"
  if [[ -z "${EXPECTED_LINE}" ]]; then
    echo "Checksum for ${BINARY} not found in SHA256SUMS-hook." >&2
    exit 1
  fi
  EXPECTED_HASH="$(echo "${EXPECTED_LINE}" | awk '{print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${EXPECTED_HASH}  ${TMPDIR}/${BINARY}" | sha256sum -c - || {
      echo "Checksum verification failed!" >&2
      exit 1
    }
  elif command -v shasum >/dev/null 2>&1; then
    (cd "${TMPDIR}" && echo "${EXPECTED_HASH}  ${BINARY}" | shasum -a 256 -c -) || {
      echo "Checksum verification failed!" >&2
      exit 1
    }
  else
    echo "Neither sha256sum nor shasum is installed — cannot verify checksum." >&2
    exit 1
  fi
  echo "Checksum OK."
fi

# Make executable
chmod +x "${TMPDIR}/${BINARY}"

# Install
mkdir -p "${PREFIX}"
INSTALL_PATH="${PREFIX}/${INSTALL_NAME}"

# Detect an existing install so we can report this as an upgrade rather
# than a silent overwrite. Use a timeout so a broken old binary can't hang
# the install, and capture stderr too (some binaries print version there).
if [[ -x "${INSTALL_PATH}" ]]; then
  if command -v timeout >/dev/null 2>&1; then
    OLD_VERSION="$(timeout 5s "${INSTALL_PATH}" --version 2>&1 | head -n1 || echo "unknown")"
  elif command -v gtimeout >/dev/null 2>&1; then
    OLD_VERSION="$(gtimeout 5s "${INSTALL_PATH}" --version 2>&1 | head -n1 || echo "unknown")"
  else
    OLD_VERSION="$("${INSTALL_PATH}" --version 2>&1 | head -n1 || echo "unknown")"
  fi
  [[ -z "${OLD_VERSION}" ]] && OLD_VERSION="unknown"
  echo "Upgrading existing install (was: ${OLD_VERSION})..."
fi

if [[ -w "${PREFIX}" ]]; then
  mv "${TMPDIR}/${BINARY}" "${INSTALL_PATH}"
else
  echo "Installing to ${INSTALL_PATH} (requires sudo)..."
  sudo mv "${TMPDIR}/${BINARY}" "${INSTALL_PATH}"
fi

echo ""
echo "Installed: ${INSTALL_PATH}"
echo ""
echo "Next steps:"
echo "  aiot login      # authenticate via GitHub OAuth"
echo "  aiot install    # set up background services + hook snippet"
echo "  aiot status     # check health"
echo ""

# Mac quarantine warning
if [[ "${OS}" == "Darwin" ]]; then
  if xattr "${INSTALL_PATH}" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "Note: macOS quarantine attribute detected. If the binary is unsigned, run:"
    echo "  xattr -d com.apple.quarantine \"${INSTALL_PATH}\""
    echo ""
  fi
fi
