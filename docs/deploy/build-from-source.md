# Build from source

Deploy the full stack by building all four application images from source on your own infrastructure. No pre-built images are pulled from any external registry.

## When to use this path

- Org policy forbids running images from public external registries (GHCR).
- You need to audit or modify the source before deployment.
- You operate behind a firewall that can reach GitHub for source but not for image pulls.

## Prerequisites

- Docker with Compose v2.30 or newer
- `just` 1.43 or newer
- ~2 GB RAM available for the build (Bun + Next.js compilation)
- Network access to pull base images on first build (`oven/bun:1.3.14-alpine`, `node:24-alpine`, `timescale/timescaledb`, `quay.io/minio/minio`, `quay.io/minio/mc`). For fully offline builds, mirror these to a local registry first.

## Steps

### 1. Clone the repo at a pinned tag

```bash
git clone https://github.com/yorch/ai-agents-observability.git
cd ai-agents-observability
git checkout v1.0.0   # replace with the tag you want
```

### 2. Configure environment

```bash
just prod-init
# Edit .env.production: fill required credentials and deployment settings.
just prod-keys
just prod-config
```

### 3. Build and start the stack

```bash
just prod-source-up
```

This single command:
- Builds all four application images locally (`web`, `ingest`, `github-app`, `migrations-runner`)
- Starts the infra stack (TimescaleDB, MinIO, Prometheus, Grafana)
- Runs migrations (one-shot, gates the app services)
- Starts the app services

### 4. Verify

```bash
curl -sf http://localhost:3000/health && echo "web OK"
curl -sf http://localhost:4000/health && echo "ingest OK"
```

## Updating

There is no auto-update with this path. To update:

```bash
git pull
git checkout v1.1.0   # new tag
just prod-source-up
```

The migration runner is idempotent (`prisma migrate deploy` + `applySqlMigrations`), so schema changes ship with the code that needs them.

## Behind an existing reverse proxy

Layer the Traefik overlay on top:

```bash
just prod-source-traefik-up
```

Set `DOMAIN_APP` and `DOMAIN_GITHUB` in `.env.production`. See
`docker-compose.traefik.yml` for requirements.

## Tradeoffs

- **No auto-update.** Updates require a `git pull` + rebuild. This is by design — the point is full control over what runs.
- **Build time.** The first build takes 5–10 minutes depending on hardware. Subsequent builds use Docker layer cache and are faster.
- **Base images still pulled.** The Dockerfiles use `oven/bun:1.3.14-alpine`, `node:24-alpine`, etc. For a fully air-gapped build, mirror these base images to a local registry and update the `FROM` lines (or use Docker's registry mirror config).
