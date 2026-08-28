# Deployment options

ai-agents-observability can be deployed several ways depending on your security, governance, and infrastructure constraints. This page is the entry point — pick the path that matches your constraints, then follow the linked runbook.

## Decision matrix

| Constraint | Primary path | Secondary | Runbook |
|---|---|---|---|
| **Standard / homelab** | Pre-built images from GHCR + Docker Compose | — | [README.md](../../README.md) |
| **Internal registry only** | Helm chart with `image.registry` set to internal | Registry sync recipe (below) | [kubernetes.md](./kubernetes.md) |
| **Supply-chain compliance** | cosign + SBOM + GitHub build provenance | Internal registry re-scan | [Verification](#verifying-supply-chain-attestations) |
| **Air-gapped / no outbound** | OCI tarball release + `docker load` | Helm chart with `pullPolicy: IfNotPresent` | [air-gapped.md](./air-gapped.md) |
| **Kubernetes mandate** | Helm chart | — | [kubernetes.md](./kubernetes.md) |
| **No external image trust** | Build from source | Helm chart with locally-built images | [build-from-source.md](./build-from-source.md) |
| **No container runtime** | Server binaries + web tarball | — | [binaries.md](./binaries.md) |
| **Hook binary distribution** | GitHub Releases | `curl \| sh` install script | [hook-binary.md](./hook-binary.md) |

## Available paths

### 1. Pre-built images + Docker Compose (default)

The standard path. Images are published to `ghcr.io/yorch/ai-agents-observability/*`
for each approved release. Production uses `.env.production`, never the host-native
`.env` development file.

```bash
just prod-init
# Fill the required values and choose one release tag in .env.production.
just prod-keys
just prod-config
just prod-up
```

The equivalent command without `just` is:

```bash
APP_ENV_FILE=.env.production docker compose --env-file .env.production \
  -f docker-compose.infra.yml -f docker-compose.prod.yml up -d
```

Compose v2.30 or newer is required for raw service env files, which preserve literal
`$` characters in application secrets. Values Compose interpolates into the model
(such as bundled database and MinIO credentials) must represent a literal `$` as `$$`.
See [README.md](../../README.md) for the full setup guide.

### 2. Build from source

Clone the repo at a pinned tag and build all four images locally. No external image trust required.

```bash
just prod-source-up
```

See [build-from-source.md](./build-from-source.md).

### 3. Air-gapped (OCI tarball release)

For every approved release, CI publishes each image as an OCI archive (`.tar`) + checksums + SBOM to the GitHub Release. Download, verify, `docker load`, and deploy with no outbound network.

See [air-gapped.md](./air-gapped.md).

### 4. Kubernetes (Helm chart)

A Helm chart packages all four services + TimescaleDB + MinIO. Supports internal registries, external DB/S3, ingress, and air-gapped deployments.

```bash
helm install ai-agents-observability deploy/helm/ai-agents-observability/ -f my-values.yaml
```

See [kubernetes.md](./kubernetes.md).

### 5. Server binaries + web tarball (no container runtime)

Ingest and github-app are compiled as standalone Bun binaries (~70 MB each). The web app is packaged as a Next.js standalone tarball (~16 MB, requires Node >= 24). Migrations still need Docker or Bun from source. Deploy directly on VMs, bare metal, or under systemd.

```bash
# Download from GitHub Releases
gh release download v1.0.0 --repo yorch/ai-agents-observability \
  --pattern "ingest-server-linux-x64" \
  --pattern "github-app-server-linux-x64" \
  --pattern "web-standalone-*.tar.gz"
```

See [binaries.md](./binaries.md).

### 6. Hook binary distribution

The `claude-telemetry` hook binary is published to GitHub Releases with per-platform binaries + checksums. Mac binaries are codesigned + notarized when Apple signing secrets are configured.

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install-hook.sh | bash
```

See [hook-binary.md](./hook-binary.md).

## Internal registry sync recipe

If org policy requires images to live in your internal registry (Harbor, Artifactory, ECR, GAR, ACR), sync from GHCR on each release:

```bash
#!/bin/bash
# sync-to-internal-registry.sh
TAG=$1
INTERNAL_REGISTRY="harbor.internal.corp.com"
REPO="ai-agents-observability"

for COMPONENT in web ingest github-app migrations-runner; do
  SRC="ghcr.io/yorch/ai-agents-observability/${COMPONENT}:${TAG}"
  DST="${INTERNAL_REGISTRY}/${REPO}/${COMPONENT}:${TAG}"

  # Pull, re-tag, push
  docker pull "${SRC}"
  docker tag "${SRC}" "${DST}"
  docker push "${DST}"

  # Verify signature (if cosign is available)
  cosign verify "${SRC}" \
    --certificate-identity "https://github.com/yorch/ai-agents-observability/.github/workflows/docker.yml@refs/heads/main" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

  echo "Synced ${COMPONENT}:${TAG}"
done
```

Then point your deployment at the internal registry:

- **Docker Compose**: set `APP_IMAGE_WEB=harbor.internal.corp.com/ai-agents-observability/web:v1.0.0` (etc.) in `.env.production`
- **Helm**: set `image.registry: harbor.internal.corp.com/ai-agents-observability` in `values.yaml`

Note: cosign signatures don't follow images through a re-push. Re-sign in your internal registry, or verify the source image's signature before re-pushing.

## Verifying supply-chain attestations

Every image published to GHCR is signed with cosign (keyless via GitHub OIDC) and has an SBOM (CycloneDX) and a GitHub build-provenance attestation.

### Verify image signature

```bash
cosign verify ghcr.io/yorch/ai-agents-observability/web:v1.0.0 \
  --certificate-identity "https://github.com/yorch/ai-agents-observability/.github/workflows/docker.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

### Verify build provenance

```bash
docker login ghcr.io
gh attestation verify \
  oci://ghcr.io/yorch/ai-agents-observability/web:v1.0.0 \
  --repo yorch/ai-agents-observability
```

### Download SBOM

SBOMs are attached to each GitHub Release as `sbom-<component>-<tag>.json` (CycloneDX format). Download with:

```bash
gh release download v1.0.0 --repo yorch/ai-agents-observability --pattern "sbom-*.json"
```

## Files

| File | Purpose |
|---|---|
| `.env.production.example` | Production-only environment template |
| `Justfile` | Named local-development and production Compose workflows |
| `docker-compose.prod.yml` | Pre-built image deployment (default) |
| `docker-compose.self-hosted.yml` | Build-from-source overlay |
| `docker-compose.traefik.yml` | Traefik reverse proxy overlay |
| `docker-compose.watchtower.yml` | Auto-update overlay |
| `deploy/helm/ai-agents-observability/` | Helm chart for Kubernetes |
| `scripts/install-hook.sh` | Hook binary install script |
| `scripts/package-web.sh` | Web tarball packaging script |
