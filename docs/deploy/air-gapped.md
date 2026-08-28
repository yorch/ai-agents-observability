# Air-gapped deployment

Deploy the full stack in an environment with no internet access at deploy time. Images arrive as OCI archives via your approved transfer mechanism (USB, signed upload, bastion scp, etc.).

## When to use this path

- The target environment has no outbound internet access.
- Org policy requires images to be transferred through an approved offline channel.
- You need verifiable integrity (checksums + signatures) for every artifact.

## How it works

On every tag push, CI publishes each image as an OCI archive (`.tar`) to the GitHub Release for that tag, alongside a SHA256 checksum and an SBOM. You download the bundle, verify it, load the images into the target Docker daemon, and deploy with the standard prod compose — pointing `APP_IMAGE_*` at the loaded image names.

## On the internet-connected machine

### 1. Download the release bundle

```bash
TAG=v1.0.0   # replace with the tag you want
gh release download "${TAG}" --repo yorch/ai-agents-observability \
  --pattern "*.tar" \
  --pattern "*.sha256" \
  --pattern "SHA256SUMS-images" \
  --pattern "sbom-*.json"
```

Or download from the GitHub Releases page in a browser.

### 2. Verify checksums

```bash
sha256sum -c SHA256SUMS-images
```

Each `.tar` should report `OK`. Do not proceed if any file fails.

### 3. Verify image signatures (optional, if cosign is available)

The images are signed with cosign keyless signing via GitHub OIDC. To verify:

```bash
# The certificate identity follows the workflow path pattern:
# https://github.com/yorch/ai-agents-observability/.github/workflows/docker.yml@refs/tags/<TAG>
cosign verify ghcr.io/yorch/ai-agents-observability/web:${TAG} \
  --certificate-identity "https://github.com/yorch/ai-agents-observability/.github/workflows/docker.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

For offline verification, export the cosign bundle during the online step and verify with `--bundle` on the air-gapped machine. See the [cosign docs](https://github.com/sigstore/cosign) for details.

### 4. Transfer to the air-gapped environment

Transfer the `.tar` files, `SHA256SUMS-images`, and SBOMs via your approved transfer mechanism.

## On the air-gapped machine

### 1. Load images into Docker

```bash
docker load -i web-v1.0.0.tar
docker load -i ingest-v1.0.0.tar
docker load -i github-app-v1.0.0.tar
docker load -i migrations-runner-v1.0.0.tar
```

Note the image names Docker reports after each load (they'll be the original GHCR refs, e.g. `ghcr.io/yorch/ai-agents-observability/web:v1.0.0`).

### 2. Clone the repo (if not already present)

You need the compose files and `.env.example`. If git is unavailable, transfer the repo archive alongside the images.

```bash
git clone https://github.com/yorch/ai-agents-observability.git   # on the connected machine
# transfer the clone to the air-gapped machine
cd ai-agents-observability
git checkout v1.0.0
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, JWT keys, GitHub OAuth, etc.
bun run gen:keys   # if bun is available; otherwise generate keys on a connected machine
```

Set the `APP_IMAGE_*` variables to the loaded image names. If you loaded the images with their original GHCR refs, the defaults in `docker-compose.prod.yml` already match — but set them explicitly for clarity:

```bash
# .env
APP_IMAGE_WEB=ghcr.io/yorch/ai-agents-observability/web:v1.0.0
APP_IMAGE_INGEST=ghcr.io/yorch/ai-agents-observability/ingest:v1.0.0
APP_IMAGE_GITHUB=ghcr.io/yorch/ai-agents-observability/github-app:v1.0.0
APP_IMAGE_MIGRATIONS=ghcr.io/yorch/ai-agents-observability/migrations-runner:v1.0.0
```

### 4. Deploy

```bash
docker compose -f docker-compose.infra.yml \
               -f docker-compose.prod.yml up -d
```

The prod compose has `pull_policy: always` by default. Since the images are already loaded locally and there's no outbound network, set `pull_policy: never` via an override or edit the compose file. Alternatively, use the build-from-source overlay with `pull_policy: never` already set (but you'd need to build, not load):

```bash
# Simplest: create a one-line override
cat > docker-compose.airgap.yml <<'EOF'
services:
  web:
    pull_policy: never
  ingest:
    pull_policy: never
  github-app:
    pull_policy: never
  migrations:
    pull_policy: never
EOF

docker compose -f docker-compose.infra.yml \
               -f docker-compose.prod.yml \
               -f docker-compose.airgap.yml up -d
```

### 5. Verify

```bash
curl -sf http://localhost:3000/health && echo "web OK"
curl -sf http://localhost:4000/health && echo "ingest OK"
```

## Updating

There is no auto-update. To update:

1. On the connected machine: download the new tag's release bundle.
2. Transfer to the air-gapped machine.
3. `docker load` the new images.
4. Update `APP_IMAGE_*` in `.env` to the new tag.
5. `docker compose ... up -d` (the migration runner handles schema changes).

## Tradeoffs

- **No auto-update by design.** Every update is a deliberate, verified transfer.
- **Bundle size.** Four images at ~200 MB each = ~800 MB compressed. For very large images, consider splitting the transfer or using a different mechanism.
- **Base images for infra.** The `docker-compose.infra.yml` file references `timescale/timescaledb`, `quay.io/minio/minio`, etc. These also need to be available offline. Either pre-load them on the air-gapped Docker daemon, or mirror them to a local registry.
- **Signature verification offline.** Cosign keyless signatures reference the online transparency log. For fully offline verification, export the cosign bundle during the online step and use `cosign verify --bundle` on the air-gapped machine.
