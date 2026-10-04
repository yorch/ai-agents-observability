---
id: P15-003
title: Replace the deprecated MinIO with Garage as the bundled object store
phase: 15
workstream: A
status: done
owner: claude
depends_on: [P1-002, P1-012]
blocks: []
estimate: L
---

## Goal

The bundled S3 store is Garage, and a self-hoster upgrading from a MinIO-based
release can move their transcripts and judge rationales across without losing
objects or their metadata. "Done" means the parts that could not be exercised
when this was written have been run against real Docker and a real cluster.

## Context

MinIO community edition was archived upstream, and its images stopped being
anonymously pullable (`quay.io/minio/minio` → 401, Docker Hub `minio/minio` →
404), so fresh installs could not start the stack. Shipped in PR #274
(`feat(deploy)!:`, released as v3.0.0). The candidate comparison, the adversarial
review and the implementation review are in
[`docs/research/2026-10-04-minio-replacement.md`](../docs/research/2026-10-04-minio-replacement.md);
the operator guide is
[`docs/deploy/migrate-from-minio.md`](../docs/deploy/migrate-from-minio.md).

What was verified natively (no Docker was available): the Garage 2.4.1 binary
boots with `infra/garage/garage.toml` and the compose flags, creates the key and
bucket, `garage health` exits 0/1 correctly, and the repo's `@aws-sdk/client-s3`
passes every call ingest makes. A real MinIO → Garage copy passes
`scripts/verify-object-copy.ts`; a copy made without `rclone --metadata` fails it,
although `rclone check` reports no differences. `helm lint` and `helm template`
(3.18.6) pass, and the chart's refusal cases fail with clear messages.

It stayed in `review` until those parts were run, because of the lesson recorded
under Phase 15: a claim verified only by reading is a hypothesis. The project owner
ran the real-environment criteria below and reported all of them passing on
2026-10-04, after v3.0.0 was published.

## Acceptance criteria

- [x] `docker compose config` succeeds for every file combination the Justfile
      recipes use (`docker-compose.self-hosted.yml` and the traefik file are
      overrides, not standalone stacks) with a stock `.env` from `.env.example`,
      and `just prod-config` passes.
- [x] `just dev-up` on a clean checkout brings `object-store` to healthy on Linux
      (bind-mount ownership of `./data/garage`) and on macOS; ingest's `/readyz` is
      green and a transcript upload round-trips.
- [x] `just migrate-object-store` on a copy of a real, populated `./data/minio`
      completes, writes `data/garage/.minio-migration-complete`, and leaves
      `./data/minio` byte-identical; the stack then serves old transcripts and
      judge rationales.
- [x] Starting the stack with a populated `./data/minio` and no completion marker
      is refused by `scripts/check-object-store.sh`.
- [x] `helm upgrade` from the last MinIO-based chart onto a live cluster fails
      while the legacy MinIO PVC exists and `objectStore.legacyMinioPvcAcknowledged`
      is unset, and succeeds after following the Kubernetes recipe in the
      migration guide.
- [x] The v3.0.0 GitHub Release notes open with a link to
      `docs/deploy/migrate-from-minio.md` (see Implementation notes).

## Implementation notes

The release body is generated from `CHANGELOG.md`, and `release.yml` regenerates
and force-pushes the `release/vX.Y.Z` branch on every push to `main`, so a callout
edited into that branch is lost. Add it once the release is published:
`gh release edit v3.0.0 --notes-file <file>` with the callout prepended to the
existing body (`gh release view v3.0.0 --json body -q .body`).
Done on 2026-10-04: the published notes open with an `[!IMPORTANT]` callout
linking the guide at the `v3.0.0` tag.

## Files touched

- `docker-compose.{infra,app,prod,traefik,self-hosted}.yml`, `infra/garage/garage.toml`
- `scripts/check-object-store.sh`, `scripts/migrate-minio-to-garage.sh`, `scripts/verify-object-copy.ts`
- `apps/ingest/src/config.ts`
- `deploy/helm/ai-agents-observability/**`, `.github/workflows/helm-chart.yml`
- `docs/deploy/migrate-from-minio.md`, `docs/runbooks/object-store-full.md`, `SECURITY.md`

## Out of scope

- A startup warning in ingest when SSE is configured against the bundled store.
  `SECURITY.md` documents that Garage accepts the header and does not encrypt.
- Multi-node Garage. Single-node has the same redundancy as the single-drive
  MinIO it replaces; production deployments that need more use `externalS3.*`.

## Verification

```bash
docker compose -f docker-compose.infra.yml config >/dev/null
just dev-up
just migrate-object-store            # against a copy of a real ./data/minio
helm lint deploy/helm/ai-agents-observability
```
