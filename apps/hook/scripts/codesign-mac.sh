#!/usr/bin/env bash
# Mac codesigning + notarization stub.
# Only runs when APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID are set.
# Without these env vars, the binary still works on developer machines
# but will be blocked by Gatekeeper on non-developer Macs.

set -euo pipefail

BINARY="${1:?Usage: $0 <binary-path>}"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "Warning: APPLE_SIGNING_IDENTITY or APPLE_TEAM_ID not set — skipping codesign."
  echo "The binary will require developer mode or manual trust on Mac."
  exit 0
fi

echo "Codesigning ${BINARY}..."
codesign \
  --sign "${APPLE_SIGNING_IDENTITY}" \
  --options runtime \
  --entitlements "$(dirname "$0")/entitlements.plist" \
  --force \
  "${BINARY}"

echo "Notarizing ${BINARY}..."
xcrun notarytool submit "${BINARY}" \
  --team-id "${APPLE_TEAM_ID}" \
  --apple-id "${APPLE_ID:?APPLE_ID required for notarization}" \
  --password "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD required}" \
  --wait

echo "Stapling ${BINARY}..."
xcrun stapler staple "${BINARY}"

echo "Codesigning complete."
