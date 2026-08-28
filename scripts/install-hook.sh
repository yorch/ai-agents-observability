#!/usr/bin/env bash
# Install the claude-telemetry hook binary from GitHub Releases.
# Detects the platform, downloads the latest release binary, verifies the
# checksum, and installs to /usr/local/bin/claude-telemetry.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install-hook.sh | bash
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
INSTALL_NAME="claude-telemetry"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --prefix)  PREFIX="$2";  shift 2 ;;
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
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
  if [[ -z "${VERSION}" ]]; then
    echo "Could not determine latest release version." >&2
    exit 1
  fi
fi

echo "Installing claude-telemetry ${VERSION} for ${TARGET}..."

# Create temp directory
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

# Download binary and checksums
BINARY="claude-telemetry-${TARGET}"
echo "Downloading ${BINARY}..."
gh release download "${VERSION}" --repo "${REPO}" \
  --pattern "${BINARY}" \
  --pattern "SHA256SUMS-hook" \
  --dir "${TMPDIR}" 2>/dev/null || {
    # Fall back to direct download if gh is not available
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
    CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS-hook"
    curl -fsSL "${DOWNLOAD_URL}" -o "${TMPDIR}/${BINARY}" || {
      echo "Failed to download ${BINARY} from release ${VERSION}" >&2
      exit 1
    }
    curl -fsSL "${CHECKSUMS_URL}" -o "${TMPDIR}/SHA256SUMS-hook" 2>/dev/null || true
  }

# Verify checksum
if [[ -f "${TMPDIR}/SHA256SUMS-hook" ]]; then
  echo "Verifying checksum..."
  (cd "${TMPDIR}" && sha256sum -c SHA256SUMS-hook --ignore-missing) || {
    echo "Checksum verification failed!" >&2
    exit 1
  }
  echo "Checksum OK."
else
  echo "Warning: SHA256SUMS-hook not found — skipping checksum verification."
fi

# Make executable
chmod +x "${TMPDIR}/${BINARY}"

# Install
mkdir -p "${PREFIX}"
INSTALL_PATH="${PREFIX}/${INSTALL_NAME}"

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
echo "  claude-telemetry login      # authenticate via GitHub OAuth"
echo "  claude-telemetry install    # set up background services + hook snippet"
echo "  claude-telemetry status     # check health"
echo ""

# Mac quarantine warning
if [[ "${OS}" == "Darwin" ]]; then
  if xattr "${INSTALL_PATH}" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "Note: macOS quarantine attribute detected. If the binary is unsigned, run:"
    echo "  xattr -d com.apple.quarantine ${INSTALL_PATH}"
    echo ""
  fi
fi
