# Kubernetes deployment

Deploy ai-agents-observability on Kubernetes using the Helm chart.

## When to use this path

- Your org standardizes on Kubernetes and cannot run Docker Compose in production.
- You need integration with K8s-native supply-chain tooling (Sigstore policy controller, OPA/Gatekeeper, External Secrets Operator).
- You want managed database/storage via K8s operators or cloud services.

## Prerequisites

- Kubernetes 1.28+
- Helm 3.12+
- A namespace for the deployment
- (Optional) An ingress controller (nginx-ingress, Traefik, etc.)
- (Optional) A storage class for persistent volumes

## Quick start (bundled everything)

```bash
# Clone and checkout a tagged release
git clone https://github.com/yorch/ai-agents-observability.git
cd ai-agents-observability
git checkout v1.0.0

# Create namespace
kubectl create namespace ai-agents-observability

# Generate JWT keys
bun run gen:keys   # writes to .env; copy the values into your values.yaml

# Create your values file
cp deploy/helm/ai-agents-observability/values.yaml my-values.yaml
# Edit my-values.yaml: set secrets.jwtPrivateKey, secrets.jwtPublicKey,
# secrets.githubOAuthClientId, secrets.githubOAuthClientSecret, etc.

# Install
helm install ai-agents-observability deploy/helm/ai-agents-observability/ \
  -n ai-agents-observability \
  -f my-values.yaml
```

The chart deploys:
- TimescaleDB StatefulSet (or uses your external DB)
- Garage object-store StatefulSet (or uses your external S3); it creates the bucket itself
- Migrations Job (Helm pre-install hook)
- Web Deployment + Service
- Ingest Deployment + Service
- GitHub App Deployment + Service (optional)

## Install from the published OCI chart

Each release publishes the chart to GHCR, so you can install without cloning the repo:

```bash
helm install ai-agents-observability \
  oci://ghcr.io/yorch/ai-agents-observability/charts/ai-agents-observability \
  --version 2.5.1 \
  -n ai-agents-observability -f my-values.yaml
```

The chart `version` equals the release version, and `appVersion` (the default image tag) is stamped to match it. Verify the signature with `cosign verify` as described in [verifying-artifacts.md](./verifying-artifacts.md).

## Using an internal registry

For governance-compliant deployments, push images to your internal registry and point the chart at it:

```yaml
# my-values.yaml
image:
  registry: harbor.internal.corp.com/ai-agents-observability
  pullPolicy: Always
  pullSecrets:
    - name: my-registry-pull-secret
```

See [docs/deploy/README.md](./README.md) for how to get images into your internal registry (build from source, registry sync, or air-gapped import).

## Using external database and S3

For production, prefer managed backends:

```yaml
# my-values.yaml
timescaledb:
  enabled: false

externalDatabase:
  url: postgresql://user:pass@managed-postgres.internal:5432/ai_agents_observability

objectStore:
  enabled: false

externalS3:
  endpoint: https://s3.us-east-1.amazonaws.com
  accessKeyId: AKIA...
  secretAccessKey: ...
  bucket: my-org-transcripts
  region: us-east-1
  forcePathStyle: false
```

When `timescaledb.enabled` is false, the chart skips the TimescaleDB StatefulSet and uses `externalDatabase.url` for all services. Same for the bundled object store: set `objectStore.enabled=false` and `externalS3.*`. The former `minio.*` values were removed and setting them fails the render; see [migrate-from-minio.md](./migrate-from-minio.md).

## Ingress

Enable ingress for the web UI and (optionally) the GitHub App webhook receiver:

```yaml
ingress:
  enabled: true
  className: nginx  # or traefik, etc.
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: observability.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: observability-tls
      hosts:
        - observability.example.com

githubAppIngress:
  enabled: true
  className: nginx
  hosts:
    - host: github-webhook.example.com
      paths:
        - path: /
          pathType: Prefix
```

## Secrets management

For production, don't put secrets in `values.yaml`. Use External Secrets Operator or sealed-secrets:

```yaml
# my-values.yaml
secrets:
  useExistingSecret: true
  secretName: my-external-secret
```

Create the secret via External Secrets Operator pointing at Vault, AWS Secrets Manager, etc. The chart reads all secrets from the named Kubernetes Secret.

## Air-gapped Kubernetes

1. Load images onto all cluster nodes (or a local registry):
   ```bash
   # On each node (or use a local registry):
   docker load -i web-v1.0.0.tar
   docker load -i ingest-v1.0.0.tar
   docker load -i github-app-v1.0.0.tar
   docker load -i migrations-runner-v1.0.0.tar
   ```

2. Set `pullPolicy: IfNotPresent` and point at the loaded image names:
   ```yaml
   image:
     registry: ghcr.io/yorch/ai-agents-observability  # matches the loaded image names
     pullPolicy: IfNotPresent
   ```

3. Install the chart — no outbound image pulls happen.

## Disabling the GitHub App service

If you don't use PR enrichment:

```yaml
githubApp:
  enabled: false
```

The chart skips the Deployment, Service, and Ingress for the GitHub App.

## Manual migration management

If you prefer to run migrations outside Helm:

```yaml
migrations:
  enabled: false
```

Then run migrations manually:

```bash
kubectl exec -n ai-agents-observability deploy/ai-agents-observability-web -- \
  bun run db:deploy
```

## Upgrading

```bash
# Update your values if needed, then:
helm upgrade ai-agents-observability deploy/helm/ai-agents-observability/ \
  -n ai-agents-observability \
  -f my-values.yaml
```

The migration Job runs as a pre-upgrade hook. If it fails, the release is in a half-upgraded state:

```bash
helm rollback ai-agents-observability -n ai-agents-observability
kubectl logs job/ai-agents-observability-migrations -n ai-agents-observability
```

## Verification

```bash
# Check all pods are running
kubectl get pods -n ai-agents-observability

# Check web health
kubectl exec -n ai-agents-observability deploy/ai-agents-observability-web -- \
  wget -qO- http://localhost:3000/health

# Port-forward to access the UI
kubectl port-forward -n ai-agents-observability svc/ai-agents-observability-web 3000:3000
```

## Production considerations

- **TimescaleDB**: the bundled StatefulSet is a starting point. For production, use a managed Postgres with TimescaleDB extension, or the [CloudNativePG operator](https://cloudnative-pg.io/) with the TimescaleDB extension. The bundled StatefulSet has no HA, no automated backups, and no WAL archiving.
- **Object store**: same — the bundled Garage StatefulSet is single-node with no redundancy. For production, use external S3. The bundled store accepts but ignores SSE headers (see SECURITY.md).
- **Resource limits**: the defaults in `values.yaml` are conservative. Adjust based on your load.
- **Replicas**: `web` and `ingest` can be scaled horizontally (they're stateless). `github-app` can too. TimescaleDB and the object store are single-replica by default.
- **Backups**: PVC snapshots for TimescaleDB and object-store data (snapshot Garage while it is quiescent; its metadata is sqlite). Configure according to your cluster's backup strategy (Velero, etc.).
