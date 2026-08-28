#!/usr/bin/env bash
# Package the Next.js web app as a portable tarball.
#
# The tarball contains:
#   - apps/web/.next/standalone/  — the Next.js standalone server (traced deps)
#   - apps/web/.next/static/      — static assets (JS, CSS, fonts)
#   - run.sh                      — launch script that sets NODE_ENV=production
#                                   and starts `node apps/web/server.js`
#
# The target machine needs Node >= 24 on PATH. No node_modules, no Bun, no
# build step — just extract and run.
#
# Usage:
#   bash scripts/package-web.sh [output-dir]
#
# Output:
#   <output-dir>/web-standalone-<version>.tar.gz

set -euo pipefail

OUTPUT_DIR="${1:-dist}"
VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"

cd "$(git rev-parse --show-toplevel)"

# Build the Next.js standalone bundle
echo "Building Next.js standalone bundle..."
NODE_ENV=production bun run --cwd apps/web build

STANDALONE="apps/web/.next/standalone"
STATIC="apps/web/.next/static"

if [[ ! -d "${STANDALONE}" ]]; then
  echo "Error: ${STANDALONE} not found — build failed or output is not 'standalone'." >&2
  exit 1
fi

if [[ ! -d "${STATIC}" ]]; then
  echo "Error: ${STATIC} not found — static assets missing." >&2
  exit 1
fi

# Create a staging directory
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

echo "Staging tarball contents..."
mkdir -p "${STAGING}/web"

# Copy standalone bundle (includes traced node_modules)
cp -R "${STANDALONE}/." "${STAGING}/web/"

# Copy static assets (not included in standalone by default)
mkdir -p "${STAGING}/web/apps/web/.next/static"
cp -R "${STATIC}/." "${STAGING}/web/apps/web/.next/static/"

# Create launch script
cat > "${STAGING}/web/run.sh" << 'RUNSH'
#!/usr/bin/env bash
# Launch the ai-agents-observability web server.
# Requires Node >= 24 on PATH.
set -euo pipefail
export NODE_ENV=production
export PORT="${PORT:-3000}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
cd "$(dirname "$0")"
exec node apps/web/server.js
RUNSH
chmod +x "${STAGING}/web/run.sh"

# Create a README
cat > "${STAGING}/web/README.md" << 'README'
# ai-agents-observability web server

## Requirements
- Node.js >= 24

## Run
```bash
./run.sh
```

The server listens on port 3000 by default. Set `PORT` to change it.

## Environment variables
Set these before running:
- `DATABASE_URL` — PostgreSQL connection string (required)
- `JWT_ED25519_PRIVATE_KEY` / `JWT_ED25519_PUBLIC_KEY` — JWT signing keys (required)
- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — GitHub OAuth (required)
- `GITHUB_HOST` — GitHub host (default: github.com)
- `S3_*` — S3/MinIO config (for transcript proxy)
- `ADMIN_SECRET` — admin endpoint protection (optional)
README

# Package the tarball
mkdir -p "${OUTPUT_DIR}"
TARBALL="${OUTPUT_DIR}/web-standalone-${VERSION}.tar.gz"

echo "Creating ${TARBALL}..."
tar -czf "${TARBALL}" -C "${STAGING}" web/

# Report size
SIZE=$(ls -lh "${TARBALL}" | awk '{print $5}')
echo "Done: ${TARBALL} (${SIZE})"
