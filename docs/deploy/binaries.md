# Binary / tarball deployment

Deploy the server components as standalone binaries or a portable tarball instead of Docker images. This is useful when you want to run the services directly on a VM, bare metal, or under systemd without a container runtime.

## What's available

| Component | Format | Size | Runtime requirement |
|---|---|---|---|
| **ingest** | Bun compiled binary | ~70 MB | None (Bun runtime is bundled) |
| **github-app** | Bun compiled binary | ~67 MB | None (Bun runtime is bundled) |
| **web** | Node.js tarball | ~16 MB | Node >= 26 |
| **migrations-runner** | Not available as binary | — | Docker or Bun + source (reads migration files from disk at runtime) |
| **hook** | Bun compiled binary | ~50-80 MB | None (already distributed this way — see [hook-binary.md](./hook-binary.md)) |

## Why migrations-runner is not a binary

The migrations runner shells out to `bunx prisma migrate deploy` and reads `.sql` files from `packages/db/sql/migrations/` at runtime via `readdirSync` + `readFileSync`. Both require filesystem access to the source tree, so it can't be compiled into a single binary. For binary-only deployments, run migrations using the Docker image or from source with Bun.

## Building locally

### Ingest

```bash
# Current platform
bun run --cwd apps/ingest build:compile

# All platforms (cross-compile)
bun run --cwd apps/ingest build:all
```

Output: `apps/ingest/dist/ingest-server[-<target>]`

### GitHub App

```bash
# Current platform
bun run --cwd apps/github-app build:compile

# All platforms
bun run --cwd apps/github-app build:all
```

Output: `apps/github-app/dist/github-app-server[-<target>]`

### Web tarball

```bash
bash scripts/package-web.sh dist
```

Output: `dist/web-standalone-<version>.tar.gz`

### Important: NODE_ENV=production at compile time

The build scripts set `NODE_ENV=production` at compile time. This is critical: Bun's `--compile` bakes in `NODE_ENV` at build time, and pino's `pino-pretty` transport (used in development) relies on worker threads that are incompatible with Bun's compiled binary virtual filesystem. In production mode, pino writes plain JSON with no worker thread, so the binary runs clean.

## Downloading from GitHub Releases

For every approved release, CI builds all artifacts and publishes them to the GitHub Release:

```bash
TAG=v1.0.0

# Download server binaries
gh release download "${TAG}" --repo yorch/ai-agents-observability \
  --pattern "ingest-server-linux-x64" \
  --pattern "github-app-server-linux-x64" \
  --pattern "web-standalone-*.tar.gz" \
  --pattern "SHA256SUMS-binaries"
```

Available targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.

## Verify

```bash
sha256sum -c SHA256SUMS-binaries --ignore-missing
```

## Deploy: ingest

```bash
chmod +x ingest-server-linux-x64

# Set required env vars
export DATABASE_URL=postgresql://user:pass@host:5432/ai_agents_observability
export S3_ENDPOINT=http://minio:9000
export S3_ACCESS_KEY_ID=minioadmin
export S3_SECRET_ACCESS_KEY=minioadmin
export S3_BUCKET=transcripts
export S3_REGION=us-east-1
export S3_FORCE_PATH_STYLE=true
export INGEST_PORT=4000
export GIT_SHA=v1.0.0   # or $(git rev-parse --short HEAD) if deployed from a clone

# Run
./ingest-server-linux-x64
```

## Deploy: github-app

```bash
chmod +x github-app-server-linux-x64

export DATABASE_URL=postgresql://user:pass@host:5432/ai_agents_observability
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY=...
export GITHUB_APP_WEBHOOK_SECRET=...
export GITHUB_HOST=https://github.com
export GITHUB_APP_PORT=4001
export GIT_SHA=v1.0.0

./github-app-server-linux-x64
```

## Deploy: web

```bash
# Extract
tar -xzf web-standalone-v1.0.0.tar.gz
cd web/

# Set required env vars
export DATABASE_URL=postgresql://user:pass@host:5432/ai_agents_observability
export JWT_ED25519_PRIVATE_KEY=...
export JWT_ED25519_PUBLIC_KEY=...
export GITHUB_OAUTH_CLIENT_ID=...
export GITHUB_OAUTH_CLIENT_SECRET=...
export GITHUB_HOST=https://github.com
export S3_ENDPOINT=http://minio:9000
export S3_ACCESS_KEY_ID=minioadmin
export S3_SECRET_ACCESS_KEY=minioadmin
export S3_BUCKET=transcripts
export S3_REGION=us-east-1
export S3_FORCE_PATH_STYLE=true
export PORT=3000

# Run (requires Node >= 26)
./run.sh
```

## Running under systemd

### Ingest

```ini
# /etc/systemd/system/ai-agents-ingest.service
[Unit]
Description=AI Agents Observability — Ingest
After=network.target postgresql.service

[Service]
Type=simple
ExecStart=/opt/ai-agents-observability/ingest-server-linux-x64
Environment=DATABASE_URL=postgresql://user:pass@localhost:5432/ai_agents_observability
Environment=S3_ENDPOINT=http://localhost:9000
Environment=S3_ACCESS_KEY_ID=minioadmin
Environment=S3_SECRET_ACCESS_KEY=minioadmin
Environment=S3_BUCKET=transcripts
Environment=S3_REGION=us-east-1
Environment=S3_FORCE_PATH_STYLE=true
Environment=INGEST_PORT=4000
Environment=GIT_SHA=v1.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### GitHub App

```ini
# /etc/systemd/system/ai-agents-github-app.service
[Unit]
Description=AI Agents Observability — GitHub App
After=network.target postgresql.service

[Service]
Type=simple
ExecStart=/opt/ai-agents-observability/github-app-server-linux-x64
Environment=DATABASE_URL=postgresql://user:pass@localhost:5432/ai_agents_observability
Environment=GITHUB_APP_ID=...
Environment=GITHUB_APP_PRIVATE_KEY=...
Environment=GITHUB_APP_WEBHOOK_SECRET=...
Environment=GITHUB_HOST=https://github.com
Environment=GITHUB_APP_PORT=4001
Environment=GIT_SHA=v1.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Web

```ini
# /etc/systemd/system/ai-agents-web.service
[Unit]
Description=AI Agents Observability — Web
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/ai-agents-observability/web
ExecStart=/opt/ai-agents-observability/web/run.sh
Environment=DATABASE_URL=postgresql://user:pass@localhost:5432/ai_agents_observability
Environment=JWT_ED25519_PRIVATE_KEY=...
Environment=JWT_ED25519_PUBLIC_KEY=...
Environment=GITHUB_OAUTH_CLIENT_ID=...
Environment=GITHUB_OAUTH_CLIENT_SECRET=...
Environment=GITHUB_HOST=https://github.com
Environment=S3_ENDPOINT=http://localhost:9000
Environment=S3_ACCESS_KEY_ID=minioadmin
Environment=S3_SECRET_ACCESS_KEY=minioadmin
Environment=S3_BUCKET=transcripts
Environment=S3_REGION=us-east-1
Environment=S3_FORCE_PATH_STYLE=true
Environment=PORT=3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-agents-ingest ai-agents-github-app ai-agents-web
sudo systemctl status ai-agents-ingest
```

## Migrations

Binary deployments still need migrations. Options:

1. **Run the migrations Docker image** (one-shot, then remove):
   ```bash
   docker run --rm --network host \
     -e DATABASE_URL=postgresql://user:pass@localhost:5432/ai_agents_observability \
     ghcr.io/yorch/ai-agents-observability/migrations-runner:v1.0.0
   ```

2. **Run from source with Bun** (if Bun is installed):
   ```bash
   git clone https://github.com/yorch/ai-agents-observability.git
   cd ai-agents-observability
   git checkout v1.0.0
   bun install --frozen-lockfile
   DATABASE_URL=postgresql://user:pass@localhost:5432/ai_agents_observability bun run db:deploy
   ```

Run migrations before starting the server binaries. The migration runner is idempotent (`prisma migrate deploy` + `applySqlMigrations`), so re-running is safe.

## Updating

1. Download the new release binaries/tarball.
2. Verify checksums.
3. Stop the systemd services.
4. Run migrations (if the new version has schema changes).
5. Replace the binaries/tarball.
6. Start the services.

## Tradeoffs

- **No auto-update.** Updates are a manual download + replace. This is by design for governance-controlled environments.
- **Migrations still need Docker or Bun.** The migration runner can't be compiled as a binary because it reads migration files from disk at runtime.
- **Web requires Node >= 26.** The web tarball is a Next.js standalone bundle, not a compiled binary. Node must be installed on the target machine.
- **Web tarball is built for linux-x64 in CI.** The standalone bundle includes a native `keytar.node` binding compiled for the CI runner's platform. On macOS or ARM Linux, keytar fails to load — the web app falls back to file-based token storage (`packages/auth/src/keychain.ts` has a try/catch). This is transparent but undocumented in the tarball itself.
- **No health check built into systemd units.** The units above use `Type=simple` with `Restart=always`. For active health checks, add a `ExecStartPost` or use an external monitor.
