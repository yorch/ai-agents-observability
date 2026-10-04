# Replacing the Bundled MinIO: Options Assessment and Migration Plan

**Date:** 2026-10-04
**Scope:** Which S3-compatible store the stack should bundle now that MinIO Community Edition is dead, and how existing self-hosted users move over.
**Status:** Research / proposal. No code or config has been changed. Recommendation: **Garage (single-node mode) as the bundled default, SeaweedFS as the fallback, BYO S3 stays first-class.** Several claims below are marked **[unverified]**; section 7 lists the spike that must run before implementation.

---

## 0. TL;DR

- **Why now.** The pinned image `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` (`docker-compose.infra.yml:36`, `deploy/helm/.../values.yaml:55-56`) is the last community release. Upstream stopped publishing images in Oct 2025, the repo is archived (reported 2026-04-25; sources disagree between 2026-02-13 and 2026-04-25, which does not change the conclusion), Docker Hub `minio/minio` is gone, and the frozen quay image carries unpatched CVEs. One source also reports quay.io began requiring auth for anonymous pulls on 2026-09-24 **[unverified; single SEO-grade source]**. A fresh clone that cannot pull its object store is a broken product.
- **Our S3 surface is tiny.** Six commands (`PutObject` with user metadata, `HeadObject`, `GetObject` streamed, `DeleteObject(s)`, `ListObjectsV2`, `HeadBucket`), path-style, SigV4, objects written with a single PUT. No presigned URLs, multipart, versioning, object lock or ACLs. Almost every candidate satisfies this, so the decision is about **operability, license, maintenance health and migration cost**, not feature coverage.
- **Garage wins on those axes.** v2.3.0 added `garage server --single-node --default-bucket` plus `GARAGE_DEFAULT_{ACCESS_KEY,SECRET_KEY,BUCKET}`, which removes the `createbuckets` init container entirely. ~20-27 MB image on amd64/arm64/arm/386, one static Rust binary, AGPL-3.0 (same license as MinIO, no change in our posture), sponsored non-profit maintainer, an official Helm chart in-tree, and ~23 MiB idle RAM versus ~450 MiB for MinIO in one third-party measurement.
- **Zero application code change.** `S3_*` env vars, `@aws-sdk/client-s3`, `forcePathStyle` all stay. The change is compose, Helm, docs, and a migration script.
- **Real costs.** No web console, no SSE, no versioning/object lock (we use none), key IDs must be Garage-shaped (cannot reuse `minioadmin`) **[unverified]**, region must be set to match, and Garage's own docs call a single node "not for production" (the same caveat applies to single-drive MinIO, which is what we run today).
- **Side finding (bug).** The dev/prod compose `createbuckets` job installs a hard 365-day bucket expiry (`docker-compose.infra.yml:62`) that fights the app's per-team retention overrides (up to `ORG_MAX_RETENTION_DAYS`, default 730; `apps/ingest/src/config.ts:97-99`). And the Helm chart never creates the bucket at all. Both disappear in the Garage design.

---

## 1. Inventory: what the project actually uses from S3

### 1.1 Client and addressing

| Aspect | Finding | Evidence |
|---|---|---|
| Client library | `@aws-sdk/client-s3` v3 in ingest, web and the seed script. Not Bun's native `S3Client`. | `apps/ingest/src/index.ts:3,22-30`, `apps/web/src/lib/s3.ts:3,7-15`, `packages/db/src/seed.ts:18` |
| Addressing | **Path-style.** Ingest reads `S3_FORCE_PATH_STYLE`, default `true` (`apps/ingest/src/config.ts:103-107`). Web **hard-codes** `forcePathStyle: true` and ignores the env var (`apps/web/src/lib/s3.ts:12`). Helm default for external S3 is `false` (`values.yaml:81`). | cited |
| Auth | Static access key + secret via env; SigV4 (SDK default). No STS/IAM roles. | `config.ts:100,111`, `index.ts:23-26` |
| Region | `S3_REGION` default `us-east-1` (`config.ts:110`). MinIO accepted any region; Garage rejects a mismatch (section 2.2). | cited |
| Endpoint | Required, URL-validated (`config.ts:102`). Defaults point at the compose service name `http://minio:9000` (`docker-compose.app.yml:56,90`, `docker-compose.prod.yml:53,83`), `docs/deploy/binaries.md:87,130`. | cited |

### 1.2 Operations actually issued

| Operation | Where | Notes |
|---|---|---|
| `PutObject` (single PUT, `Metadata`, `ContentType`, optional `ServerSideEncryption`/`SSEKMSKeyId`) | `apps/ingest/src/lib/s3.ts:30-53`; seed `packages/db/src/seed.ts` | Whole transcript buffered in memory, "single-PUT … simpler than streaming multipart" (`transcript-pipeline.ts:35-36`). **No multipart.** User metadata holds the upload's sha256, used for idempotency (`routes/transcripts.ts:22,212-217`). Metadata round-trip is therefore load-bearing. |
| `HeadObject` | `lib/s3.ts:12-28` | Reads user metadata; 404/`NotFound` mapped to null. |
| `GetObject` (streamed, then zstd-decompressed) | `apps/web/src/lib/s3.ts:25-54`, three web routes | Proxied through the web app; **no presigned URLs anywhere** (grep for `presign`/`getSignedUrl` returns nothing). |
| `DeleteObject` | `apps/ingest/src/jobs/sweep-retention.ts:95` | Retention sweep. |
| `DeleteObjects` (batch up to 1000) | `jobs/run-deletions.ts:58-73` | GDPR-style user deletion. |
| `ListObjectsV2` (prefix `transcripts/`, `MaxKeys: 500`, continuation token) | `jobs/sweep-retention.ts:125-145` | Orphan sweep. |
| `HeadBucket` | `apps/ingest/src/index.ts:37-39` | `/readyz` `checks.s3`. |

Key layout: `transcripts/{yyyy}/{mm}/{dd}/{userId}/{sessionId}.jsonl.zst` (`lib/s3.ts:61-66`). Objects are already zstd-compressed, so store-side compression gains nothing.

### 1.3 Features NOT used

Presigned URLs, multipart upload, bucket versioning, object lock/retention/legal hold, bucket policies/ACLs, object tagging, S3 events/notifications, website hosting, CopyObject. SSE is **optional and off by default**: only sent when `S3_SSE_ALGORITHM` is set (`config.ts:112-115`, `app.ts:93-97`); `SECURITY.md:149-154` already tells MinIO users not to set it. A store without SSE therefore loses nothing today.

### 1.4 Lifecycle / retention

- Authoritative retention is **application-side**: `sweep-retention` deletes by session age with per-team overrides clamped by `ORG_MAX_RETENTION_DAYS` (`config.ts:97-99`, `.env.example:65-69`).
- A **redundant** store-side rule is installed only by the dev/prod init container: `mc ilm rule add --expire-days 365 local/transcripts` (`docker-compose.infra.yml:62`). It is documented as a feature in `docs/runbooks/minio-full.md:~40` and `DESIGN_DOC.md:1070`. Because it ignores team overrides, any team with retention above 365 days silently loses transcripts at 365. I recommend **not** reproducing it (section 4.4).
- Helm creates no bucket and no lifecycle rule (`grep -rn -i bucket deploy/helm` returns only the value plumbing). Bundled-MinIO Helm installs depend on someone creating `transcripts` by hand.

### 1.5 Operational surface

| Item | Today | Evidence |
|---|---|---|
| Healthcheck | `curl -sf http://localhost:9000/minio/health/live`, 5s/5s/12 retries | `docker-compose.infra.yml:46-50` |
| Init container | `createbuckets` using `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z`: `mc alias set`, `mc mb --ignore-existing`, `mc ilm rule add` | `docker-compose.infra.yml:53-68`; prod overlay re-declares its env (`docker-compose.prod.yml:25-27`) |
| Console | `MINIO_CONSOLE_PORT=9001`; used in runbook and on-call docs | `docker-compose.infra.yml:43`, `.env.example:30`, `docs/runbooks/minio-full.md`, `docs/on-call.md:16,59` |
| Data dir | bind mount `./data/minio:/data` (MinIO's xl.meta format; not readable by any other server) | `docker-compose.infra.yml:45`; `.gitignore:28,65-66`; `scripts/clean.ts:19`; `AGENTS.md:136` |
| Root creds | `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` are reused as the app's `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` | `docker-compose.app.yml:54,59,88,92`; `docker-compose.prod.yml:54-55,84-85` |
| External-S3 escape hatch | `S3_ENDPOINT_OVERRIDE`, `S3_ACCESS_KEY_ID_OVERRIDE`, `S3_SECRET_ACCESS_KEY_OVERRIDE` | `docker-compose.prod.yml:53-55,83-85`; `.env.production.example:31-34` |
| Traefik overlay | `minio: ports: !reset []` | `docker-compose.traefik.yml:14-15` |
| Helm | StatefulSet + ClusterIP Service on 9000/9001, probes on `/minio/health/live`, `minio.*` values, `externalS3.*` values, helpers pick external when `externalS3.endpoint` is set | `templates/minio.yaml:1-98`, `values.yaml:49-83`, `_helpers.tpl:91-140`, `NOTES.txt:55-58` |
| CI | Helm render with `--set minio.enabled=false` | `.github/workflows/helm-chart.yml:65` |
| Air-gapped / build docs | name `quay.io/minio/minio` and `quay.io/minio/mc` as images to mirror | `docs/deploy/air-gapped.md:147`, `build-from-source.md:16,45,79` |
| Tests | Ingest tests stub the S3 client (`apps/ingest/test/helpers.ts:42`); **nothing in CI exercises a real S3 server.** A replacement therefore ships with no automated compatibility proof unless we add one (section 5, step 6). |

---

## 2. Candidates

Facts are from the project pages and the sources listed at the end; anything resting on a single secondary source is flagged. "Fit" is against section 1, not general S3 completeness.

### 2.1 Summary matrix

| Candidate | License | Health (Oct 2026) | Fit for our 6 ops | Single-node footprint | Multi-arch image | Helm | Migrate from MinIO | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Garage** | AGPL-3.0 | Deuxfleurs non-profit, since 2020, frequent releases (v2.2.0 2026-01-26, v2.3.0, v2.4.1 ~Sep 2026), 4.6k stars | Full: Put/Get/Head/Delete/DeleteObjects/ListV2/multipart/presign/path+vhost. Lifecycle: Expiration + AbortIncompleteMPU only. **No** SSE, versioning, object lock, tagging, policies | ~20-27 MB image, ~23 MiB idle RAM (third-party) | amd64, arm64, arm, 386 | Official in-tree chart, cluster-oriented (CRD, RF=3 default) | rclone copy; different on-disk format | **Default** |
| **SeaweedFS** | Apache-2.0 (separate paid enterprise edition) | 35k stars, 15k commits, since 2012; **but** a 2026 run of S3 CVEs (path traversal in CopyObject and DeleteObjects, unauthenticated filer IAM gRPC) fixed in 4.34 | Full incl. lifecycle, versioning, object lock, SSE-S3/KMS/C | `weed mini`/`weed server -s3`: master+volume+filer+S3+admin UI in one process; heavier than Garage | Docker Hub `chrislusf/seaweedfs`, multi-arch | Community chart | rclone | **Fallback** |
| **RustFS** | Apache-2.0 | 1.0.0 GA **2026-09-16** (3 weeks old); 34k stars; critical hardcoded-gRPC-token CVE-2025-68926 (fixed alpha.78) and 12 listed CVEs | Core S3, lifecycle, versioning, lock, SSE. S3 coverage "partial, validate your workload" | Rust, light; container runs UID 10001 | amd64+arm64 | Helm for k8s | rclone (MinIO on-disk compat is preview, `rio-v2` flag) | Watch list; too young |
| **pgsty/minio** (community fork) | AGPL (code); one source says CC BY 4.0 for docs **[unverified]** | Single maintainer (Pigsty's Ruohang Feng) using AI agents; RELEASE.2026-04-17 closed 4 CVEs | Identical to MinIO, console restored | Same as MinIO | Docker Hub `pgsty/minio`, arm64, deb/rpm | Existing chart works | **Zero-copy**: same data dir | Documented stop-gap only |
| **Chainguard `cgr.dev/chainguard/minio`** | Chainguard terms over AGPL source | Rebuilt daily from frozen upstream source; "free" per Chainguard docs | Identical to MinIO | Same | Multi-arch | n/a | Same data dir | Patches the *image*, not the *code*; no upstream to take fixes from. Stop-gap only |
| **versitygw** | Apache-2.0 | v1.5.0 2026-06-02; Versity (company) | Full S3 façade over POSIX dir or another S3 | Tiny; files stay as plain files on disk | Docker Hub | none known | Trivial: objects become files | Interesting niche (see 2.8); no durability story of its own |
| **Ceph RGW** | LGPL-2.1/3 | Very healthy | Full | RGW 256-512 MB per worker, OSDs 2-8 GB; 4 GB/40 GB is a *demo* | yes | Rook | rclone | Wrong scale (needs a cluster). Rejected |
| **Zenko CloudServer** (Scality) | Apache-2.0 | Active (last commit 2026-08-10, 81 commits last quarter) | Full for dev/test; file/in-memory backends | Node.js, hundreds of MB | amd64 mostly **[unverified arm64]** | none | rclone | Positioned as dev/test and a multi-cloud gateway, not a durable single-node store. Rejected |
| **BYO S3 only** (AWS S3, R2, B2, Tigris, any managed) | n/a | n/a | Whatever the provider supports | zero (no container) | n/a | n/a | rclone | Already supported; stays the production recommendation |

### 2.2 Garage in detail (the recommendation)

**Fit.** Every operation in 1.2 is on Garage's supported list: `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `DeleteObjects`, `ListObjectsV2`, multipart, SigV4, path-style and vhost-style, presigned URLs, `GetBucketLocation`. Unsupported (versioning stub, object lock, SSE, ACLs/policies, tagging, SigV2) are all outside section 1.3.

**Gotchas that affect us**

1. **Region must match.** Default `s3_region = "garage"`; a client sending `us-east-1` gets "Authorization header malformed, unexpected scope". We set `s3_region = "us-east-1"` in the shipped `garage.toml` so our existing `S3_REGION` default keeps working, and so users who set `S3_REGION` must also change the Garage config (documented).
2. **Key IDs are Garage-shaped.** Garage access keys are `GK` + hex. We cannot feed `minioadmin` into `GARAGE_DEFAULT_ACCESS_KEY` **[unverified: exact accepted format and whether single-node mode validates it; the quick-start example generates `GK$(openssl rand -hex 16)`]**. Consequence: the default dev credentials change, and `.env.example` ships generated-looking defaults instead of `minioadmin`.
3. **No shell in the image.** `dxflrs/garage` is a single binary; healthcheck must be exec-form (`["CMD", "/garage", "status"]` **[unverified path/exit codes]**) rather than `curl`. Admin API `GET :3903/health` exists but there is nothing in the image to call it.
4. **No console.** Replaced in runbooks by `docker exec … /garage bucket info transcripts`, `/garage status`, `/garage stats`. Optional third-party web UIs are out of scope.
5. **Single node warning.** Garage docs: single-node "provides no redundancy and should not be used in production." Equivalent to today's single-drive MinIO, which has no redundancy either, but we should say it plainly and keep BYO S3 as the production path (our docs already do: `values.yaml:50-51`).
6. **LMDB sensitivity.** Default `db_engine = lmdb` "can become corrupted after unclean shutdowns"; docs recommend sqlite as the more robust option and a checksumming FS or snapshots for metadata. We should default the shipped config to **sqlite** (slower, but our write rate is ~1 PUT per session) and document backups. LMDB files are also architecture-dependent: an amd64 to arm64 move of `./data/garage` is not possible with LMDB.
7. **Lifecycle worker** runs daily at midnight UTC. Irrelevant if we drop the bucket rule.
8. **XFS preferred, ext4 discouraged for large object counts** (inode exhaustion). Transcripts are small and numerous; note in the runbook.
9. **Licensing.** AGPL-3.0, same as MinIO. We run it unmodified as a separate container, so there is no linking/derivative concern; no change in posture.

### 2.3 SeaweedFS (the fallback)

Apache-2.0, 14 years old, broad S3 coverage including lifecycle/versioning/lock/SSE. Choose it over Garage if a user needs SSE or an Apache license. Reasons it is not the default: (a) a cluster of 2026 S3-layer CVEs (CVE-2026-55874, -55873, -58372, -72920), all fixed in 4.34, which is reassuring on response time and unreassuring on attack surface; (b) a multi-component architecture (master, volume, filer, S3, admin) even in `weed mini`; (c) a separate paid enterprise edition. Pin `>= 4.34`.

### 2.4 RustFS

GA on 2026-09-16 after beta in April and RC in August. Apache-2.0, MinIO-like ports (9000/9001) and console, active. Rejected as default because it is 3 weeks past GA, has a critical hardcoded-token CVE history from the alpha series, and the vendor itself says "S3 API coverage is partial; workload-level validation is recommended." Re-evaluate in 6 months. Adoption signal worth noting: Laravel Sail ships it.

### 2.5 pgsty/minio and Chainguard (keep-MinIO options)

These make "do nothing to the data" possible. Neither fixes the structural problem: one maintainer with AI-assisted patching (pgsty), or a rebuilt-from-frozen-source image with no upstream fixes (Chainguard). I propose **supporting them as migration sources and as a documented opt-out** (`OBJECT_STORE_IMAGE` override, section 4.2), not shipping either as the default.

### 2.6 BYO-only

Removing the bundled store entirely makes `just dev-infra-up` and the quickstart depend on a cloud account, breaks the air-gapped and homelab stories in `DESIGN_DOC.md:99`, and removes the "same code path in dev and prod" rationale (`DESIGN_DOC.md:1066-1072`). Rejected as the default, retained as the production recommendation (it already works: `S3_ENDPOINT_OVERRIDE`, `externalS3.*`).

### 2.7 Pinning the last MinIO image

Rejected: unpatched CVEs (CVE-2025-62506; CVE-2026-40344 per one source), quay may now require authentication for pulls, and the deployment would silently rot. Acceptable only as a transient migration source.

### 2.8 versitygw (noted, not chosen)

Appealing for "objects as plain files you can `ls`", which suits a bind-mount philosophy (`AGENTS.md:136`). But it adds a gateway whose durability is entirely the filesystem's, with no integrity checking of its own, and a small project footprint compared with Garage. Revisit if users ask for browsable files.

---

## 3. Recommendation

**Default: Garage `dxflrs/garage:v2.4.x` (pin to an exact tag, digest in release builds), single-node mode, sqlite metadata, region `us-east-1`, bucket `transcripts`.**
**Fallback: SeaweedFS >= 4.34** if the section 7 spike finds a blocker in Garage (key format, healthcheck, metadata round-trip), or for users who require SSE or Apache-2.0.
**Always: BYO S3 is the production-grade path**; the bundled store is for dev, homelab and small teams.

Why this over the alternatives, in one line each: smallest footprint and image; removes the init container and the cluster of MinIO-specific tooling (`mc`); license unchanged; no feature we use is missing; dedicated non-profit maintainer with steady releases; the app code is untouched.

Riskiest assumptions are listed in section 8.

---

## 4. Design

### 4.1 Naming

Keep `S3_*` as the application contract (no code change). Introduce neutral names for the bundled store so the next swap does not repeat this exercise:

| Old | New | Back-compat |
|---|---|---|
| compose service `minio` | `objectstore` | add network alias `minio` on the service so user override files, `S3_ENDPOINT=http://minio:9000` and `docs/deploy/binaries.md` keep resolving during the deprecation window |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (already the app's names; the bundled store is now seeded from the same pair) | compose: `GARAGE_DEFAULT_ACCESS_KEY: ${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER}}` so existing prod env files still start; a preflight warns if the value is not Garage-shaped (4.3) |
| `MINIO_PORT` (host S3 port, default 9000) | `S3_PORT` (default 9000, maps to container 3900) | `${S3_PORT:-${MINIO_PORT:-9000}}`. Keeping host 9000 means developers' `S3_ENDPOINT=http://localhost:9000` in `.env` needs no edit |
| `MINIO_CONSOLE_PORT` | removed | ignored with a one-line note in `.env.example` |
| container S3 port 9000 | 3900 | `S3_ENDPOINT` default inside the network becomes `http://objectstore:3900`; the `minio:9000` alias is **not** reproducible on port 9000 inside the network, so an explicit `S3_ENDPOINT=http://minio:9000` in a user's override file breaks. Mitigate by publishing Garage's S3 listener on 9000 inside the container too: set `api_bind_addr = "[::]:9000"` in the shipped `garage.toml`. This is the key compat trick: **no endpoint string anywhere changes** |
| Helm `minio.*` | `objectStore.*` (bundled) and unchanged `externalS3.*` | `minio.enabled=false` honoured for one minor: `enabled := and (not (hasKey .Values "minio" and not .Values.minio.enabled)) .Values.objectStore.enabled`; if `minio.enabled=true` is set explicitly, `fail` with a pointer to the migration doc |
| `S3_ENDPOINT_OVERRIDE`, `*_OVERRIDE` | unchanged | none needed |

Decision to settle in review: binding Garage's S3 listener to 9000 (above) versus the conventional 3900. 9000 buys zero-edit upgrades; 3900 matches Garage docs and every third-party snippet. I lean 9000 for one release, flagged in the config comment.

### 4.2 Compose

`docker-compose.infra.yml` replaces `minio` + `createbuckets` with one service:

```yaml
objectstore:
  image: ${OBJECT_STORE_IMAGE:-dxflrs/garage:v2.4.1}
  command: ["/garage", "server", "--single-node", "--default-bucket"]
  environment:
    GARAGE_DEFAULT_ACCESS_KEY: ${S3_ACCESS_KEY_ID:?...}
    GARAGE_DEFAULT_SECRET_KEY: ${S3_SECRET_ACCESS_KEY:?...}
    GARAGE_DEFAULT_BUCKET: ${S3_BUCKET:-transcripts}
    GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET:-<derived>}
  volumes:
    - ./infra/garage/garage.toml:/etc/garage.toml:ro
    - ./data/garage/meta:/var/lib/garage/meta
    - ./data/garage/data:/var/lib/garage/data
  healthcheck:
    test: ["CMD", "/garage", "status"]
  networks: { default: { aliases: [minio] } }
```

Details to verify in the spike: whether `--single-node` auto-generates `rpc_secret`/admin token (so we do not need the env), the exact `--default-bucket` semantics for an existing bucket (idempotent on restart?), and whether the data dir needs a specific UID.

`docker-compose.prod.yml:18-27` drops the two MinIO overrides and gets one `objectstore` block with `:?` guards on the S3 creds. `docker-compose.app.yml:45,54,59,88,92` and `prod.yml:53-55,67,83-85` swap `MINIO_ROOT_*` for `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` and `depends_on: minio` for `objectstore` (condition `service_healthy`; today they depend on `minio`, not on `createbuckets`, which is a latent race this removes). `docker-compose.traefik.yml:14` renames the key. `docker-compose.self-hosted.yml:11` drops `quay.io/minio/*` from its image list in the comment.

### 4.3 Preflight (the data-loss guard)

The dangerous failure is silent: user pulls the new release, `./data/minio` still holds their transcripts, Garage starts empty, and `/readyz` is green. DB rows point at keys that 404.

Add `scripts/check-object-store.ts`, called by `just dev-infra-up`, `dev-up`, `prod-up`, `prod-source-up` before `docker compose up`:

1. If `./data/minio` is non-empty **and** `./data/garage` does not exist: refuse, print the migration command (4.5). `OBJECT_STORE_ALLOW_EMPTY=1` overrides for users who truly want a fresh store.
2. If `S3_ACCESS_KEY_ID` is not Garage-shaped: print the `openssl rand` one-liners to generate a pair. (Exact regex from the spike.)
3. If `MINIO_*` vars are present: warn once with their replacements.

Compose alone cannot express (1); this is why it lives in the Justfile layer, consistent with "Justfile is the preferred interface" in `CLAUDE.md`.

### 4.4 Lifecycle and retention

Do **not** recreate the 365-day bucket rule. Retention remains owned by `sweep-retention` (`TRANSCRIPT_RETENTION_DAYS`, per-team overrides, `ORG_MAX_RETENTION_DAYS`). Update `.env.example:65`, `runbooks/minio-full.md` and `DESIGN_DOC.md:1070` ("Lifecycle rules support easy 1-year retention enforcement") accordingly. For users who want a store-side backstop, BYO S3 lifecycle rules remain available and Garage supports `Expiration` if they set one with `aws s3api`/`rclone`. State in the migration notes that the old MinIO rule is **not** carried over, and why. This is a behaviour change for anyone relying on the 365-day cap with longer team overrides configured; call it out.

### 4.5 Data migration for existing self-hosted users

Garage cannot read MinIO's on-disk layout, so this is a copy, not a swap.

**Script:** `scripts/migrate-minio-to-garage.sh` (documented in a new `docs/deploy/migrate-from-minio.md`), invoked via `just migrate-object-store`:

1. Stop `ingest` and `web` (writers) to get a consistent copy; transcripts are write-once per session key so a brief stop is simple and safe.
2. Rename `./data/minio` to keep it (`./data/minio` stays untouched until the user deletes it; we never delete).
3. Start the **old** server read-only as the source on a private network: `MIGRATION_SOURCE_IMAGE` defaults to `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`; if the pull fails (auth), the script falls back to `pgsty/minio` then `cgr.dev/chainguard/minio` and says which one it used. Users whose MinIO container is still running and cached can skip this and point at their live endpoint.
4. Start Garage on the new data dir (default-bucket mode creates `transcripts`).
5. `rclone copy --metadata --immutable minio:transcripts garage:transcripts` in an `rclone/rclone` container. `--metadata` is required so the sha256 user metadata (section 1.2) survives; **[unverified that rclone preserves `x-amz-meta-*` on S3-to-S3 with these flags; the spike must prove it]**. Do not use `--checksum` on the final pass (a reported rclone/Garage interaction, per the jacar.es write-up).
6. Verify: `rclone check --download` (multipart ETags are not comparable, though ours are single-PUT so plain `rclone check` also works), then compare **three counts**: source object count, destination object count, and `SELECT count(*) FROM sessions WHERE transcript_s3_key IS NOT NULL`. A mismatch against the DB is the check that actually matters, because it catches pre-existing orphans and missing objects.
7. Spot-check one object: `HeadObject` metadata equals the source, `GetObject` decompresses with `zstd -d`.
8. Print how to remove the old data dir and old images.

Scale sanity check: a third-party measurement copied ~10k objects (1 GB) in 42 s at 24 MiB/s; even with 1M transcripts this is an hours-scale, restartable (`rclone copy` is idempotent) job.

**Rollback:** `./data/minio` is untouched; set `OBJECT_STORE_IMAGE` to the pgsty image and restore the old compose file. Document it.

**Kubernetes:** the bundled-MinIO PVC (`data-<release>-minio-0`) is orphaned by the StatefulSet rename. Procedure: (1) keep the old StatefulSet one more release behind `objectStore.legacyMinio.enabled=true` (image configurable, no new features); (2) ship an opt-in `migrate-minio` Job template (rclone, same logic as above); (3) after success, flip `legacyMinio.enabled=false`, leaving the PVC for the user to delete. `NOTES.txt` prints the commands. Users on external S3 (`minio.enabled=false`, the production-recommended setup) need only the values rename shim.

**Binary installs** (`docs/deploy/binaries.md:87-89,130-132,157-158,215-216`): the docs use `minioadmin` credentials against `http://minio:9000`; replace with the BYO-S3 or Garage example. No runtime change.

### 4.6 Helm

Replace `templates/minio.yaml` with `templates/object-store.yaml`: a single-replica StatefulSet running `garage server --single-node --default-bucket`, config via ConfigMap (`garage.toml`) and a Secret for the key pair and RPC secret (the current chart puts credentials into plain `env.value`, `templates/minio.yaml:32-35`; moving them to a Secret is a small improvement worth making while the file is rewritten). Probes: exec `/garage status` (no `httpGet` possible against the S3 port without credentials; the admin `:3903/health` endpoint could serve `httpGet` if enabled, which is cleaner. Decide in the spike). Service exposes 9000 only (no console port). Update `_helpers.tpl:91-140` (`s3Endpoint` currently builds `http://<fullname>-minio:9000`), `NOTES.txt:55-58`, `values.yaml:49-71`, and add `externalS3.region`/`forcePathStyle` guidance. The in-tree official Garage chart is not used: it is cluster-oriented (CRD `garagenodes.deuxfleurs.fr`, default replication 3), which is the wrong shape for a single-node bundled dependency and would add a CRD to every install.

Because Garage now creates the bucket itself, the "bucket never created" gap in the current chart is fixed as a side effect. `helm-chart.yml:65` changes to `--set objectStore.enabled=false` and gets a second render without it, plus one render with `--set minio.enabled=false` to prove the shim.

### 4.7 Docs and runbooks

- `docs/runbooks/minio-full.md` becomes `object-store-full.md` (keep a one-line redirect file at the old path, since `docs/on-call.md:59` and `docs/runbooks/ingest-down.md:45` link to it). Replace console steps with `garage status`, `garage bucket info`, `garage stats`; replace `du -sh ./data/minio` with `./data/garage`; replace "re-run createbuckets" with "restart `objectstore` (default-bucket is idempotent)" **[to verify]**; drop the `mc ilm` line; add the region-mismatch and key-format failure modes to Diagnose.
- `docs/deploy/air-gapped.md:147`, `build-from-source.md:16,45,79`: one image (`dxflrs/garage`) replaces two (`minio`, `mc`).
- `docs/deploy/kubernetes.md:46,92-104,229-232`: values block, "same for MinIO/external S3", the MinIO Operator pointer (replace with "use external S3 for HA"), backups note (PVC snapshots; Garage metadata snapshot caveat).
- `SECURITY.md:66,149-154`: "S3-backed deployments (not MinIO)" becomes "(not the bundled Garage, which has no SSE)"; the sentence about MinIO default SSE behaviour changes accordingly.
- `DESIGN_DOC.md:99,131,733,1063-1075`: the 11.3 decision record gets a dated supersession note (do not rewrite history): MinIO chosen then; replaced 2026-10 by Garage because of upstream archival; lifecycle rationale updated per 4.4.
- `README.md:47`, `docs/PROJECT_OVERVIEW.md:86`, `docs/on-call.md:16,59`, `docs/deploy/README.md:43,54,82`, `AGENTS.md:136,138`, `packages/db/AGENTS.md:269`, `PLAN.md`, `presentation/index.html`, `scripts/package-web.sh:91`, `scripts/clean.ts:19`, `.gitignore:28,65-66` (add `data/garage`; `infra/.minio-data/` is already a dead path), `tasks/*` (leave historical task files alone except `tasks/INDEX.md` and a new task file).
- Add a task (next free number in `tasks/`, listed in `tasks/INDEX.md`) so status is tracked per the root `CLAUDE.md` rule.

---

## 5. Implementation sequence

1. **Spike (section 7).** Gate on results; fall back to SeaweedFS if a blocker appears.
2. **Compat test first.** Add `apps/ingest/test/s3-compat.integration.test.ts` exercising exactly the six operations plus user-metadata round-trip, against `S3_ENDPOINT` from env, skipped when unset. This is the missing proof from 1.5 and makes any future store swap a one-line CI matrix change.
3. **CI.** Add a `garage` service container (or `docker run` step) to a job in `.github/workflows/ci.yml` running that test.
4. Compose + `infra/garage/garage.toml` + preflight + Justfile recipes.
5. Migration script and `docs/deploy/migrate-from-minio.md`; test on a seeded MinIO volume built from `packages/db/src/seed.ts`.
6. Helm chart + CI render matrix.
7. Docs/runbooks/DESIGN_DOC supersession note.
8. Release as `feat(deploy)!: replace bundled MinIO with Garage`. The bang is deliberate: the default store changes and existing bundled-store users must run a migration, even though env/endpoint back-compat softens the rest. (Root `CLAUDE.md`: the parser reads subjects only, and `!` triggers major.)
9. Gate: `bun run check`, `typecheck`, `build`, `test` locally (CI skips `build`).

Also opportunistic, separate commit: make `apps/web/src/lib/s3.ts:12` honour `S3_FORCE_PATH_STYLE` like ingest does (currently hard-coded `true`; harmless for Garage, wrong for AWS virtual-host-only setups).

---

## 6. Files that would change

Compose/env: `docker-compose.infra.yml`, `docker-compose.app.yml`, `docker-compose.prod.yml`, `docker-compose.traefik.yml`, `docker-compose.self-hosted.yml` (comment), `.env.example`, `.env.production.example`, `.gitignore`, `Justfile`, **new** `infra/garage/garage.toml`, **new** `scripts/check-object-store.ts`, **new** `scripts/migrate-minio-to-garage.sh`, `scripts/clean.ts` (comment), `scripts/package-web.sh:91` (comment).

Helm: `deploy/helm/ai-agents-observability/templates/minio.yaml` (replaced by `object-store.yaml`, optional `migrate-minio-job.yaml`), `values.yaml`, `templates/_helpers.tpl`, `templates/NOTES.txt`, `Chart.yaml` (version bump), `.github/workflows/helm-chart.yml`.

App (comments/tests only, no behaviour change): `apps/ingest/src/config.ts:112-115` and `transcript-pipeline.ts:35` (comments mention MinIO), **new** `apps/ingest/test/s3-compat.integration.test.ts`, `.github/workflows/ci.yml`, optional `apps/web/src/lib/s3.ts:12`.

Docs: `docs/deploy/{README,kubernetes,air-gapped,binaries,build-from-source}.md`, **new** `docs/deploy/migrate-from-minio.md`, `docs/runbooks/minio-full.md` to `object-store-full.md`, `docs/runbooks/ingest-down.md`, `docs/on-call.md`, `docs/PROJECT_OVERVIEW.md`, `README.md`, `SECURITY.md`, `DESIGN_DOC.md`, `PLAN.md`, `AGENTS.md`, `packages/db/AGENTS.md`, `presentation/index.html`, `tasks/INDEX.md` + new task file.

---

## 7. Pre-implementation spike (must pass before step 4)

Run in a scratch directory with Garage v2.4.x, no repo changes:

1. `garage server --single-node --default-bucket` with `GARAGE_DEFAULT_*`: does it start, create the bucket, and persist across restart (idempotent)? Does it need `rpc_secret`/admin token in config or env?
2. Accepted access-key/secret formats; can the default key be set to a 32-hex ID without a `GK` prefix? What does it do with `minioadmin`?
3. Set `s3_region = "us-east-1"` and `api_bind_addr = "[::]:9000"`; run the compat test (step 2 above) with the AWS SDK and `forcePathStyle: true`.
4. `PutObject` with `Metadata: {sha256: ...}` then `HeadObject`: metadata key casing and presence. Our idempotency check depends on it.
5. `ListObjectsV2` pagination with `MaxKeys: 500` over >1000 keys; `DeleteObjects` with 1000 keys.
6. Healthcheck: `["CMD","/garage","status"]` exit codes when healthy/unhealthy and during layout bootstrap; or `:3903/health` via a minimal probe.
7. `rclone copy --metadata` from a MinIO container to Garage: metadata preserved? `rclone check` clean?
8. Container UID/permissions on a bind-mounted `./data/garage` on Linux and macOS (the `AGENTS.md:136` bind-mount philosophy).
9. Memory and startup time with sqlite vs lmdb.

Any failure in 1, 3, 4 or 7 flips the default to SeaweedFS and reuses sections 4.1-4.7 with image and probe swapped.

---

## 8. Riskiest assumptions

1. **`--single-node --default-bucket` and the `GARAGE_DEFAULT_*` env contract behave as the quick-start describes** (from the official docs; release notes themselves were not retrievable). If not, we are back to a layout/bucket/key init container using the `garage` CLI, which needs a shell image we do not have (a sidecar or a `docker exec` entrypoint).
2. **Key-ID format.** If Garage insists on `GK…`, every existing prod env file must change credentials; the preflight handles it but it is friction.
3. **User metadata round-trips through Garage and through rclone.** The idempotency path relies on it (`routes/transcripts.ts:212-217`); a miss would cause re-uploads, not data loss, but the migration correctness story depends on it.
4. **Source reliability.** Several dates and CVE claims (archival date, Docker Hub deletion on 2026-09-11, quay auth change on 2026-09-24, CVE-2026-40344, "MinIO RAM 452 MiB vs Garage 22.6 MiB") come from blog posts and aggregator pages, not primary sources. None of them change the decision (the image is unmaintained regardless), but treat the numbers as indicative.
5. **Garage's maintainer continuity.** A volunteer non-profit; mitigated by AGPL source, a compat test that makes swapping cheap, and BYO S3 as the production path.
6. **Single-node Garage is acceptable for homelab/dev.** Same redundancy as today's single-drive MinIO, but Garage's own docs say not to use it in production; our docs must say the same and point at BYO S3.
7. **Dropping the 365-day store rule is the right call.** It is a behaviour change for deployments that rely on it as a hard cap; I argue it is a latent bug against `ORG_MAX_RETENTION_DAYS`, but a reviewer may prefer to carry it over via a post-start `PutBucketLifecycleConfiguration` step.
8. **Binding Garage to container port 9000** keeps endpoints stable but deviates from Garage convention; worth a second opinion.

---

## Sources

- MinIO status: [pinggy.io, MinIO archived](https://pinggy.io/blog/minio_archived_self_hosted_s3_alternatives/), [stormdevelopments.ca](https://stormdevelopments.ca/blog/minio-s-community-edition-is-archived-what-still-runs-in-2026/), [madewithlove](https://madewithlove.com/blog/thanks-for-all-the-buckets/), [HN: MinIO stops distributing Docker images](https://news.ycombinator.com/item?id=45665452), [minio/minio repo](https://github.com/minio/minio)
- Garage: [S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/), [quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/), [configuration reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/), [real-world deployment](https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/), [GitHub mirror](https://github.com/deuxfleurs-org/garage), [Docker Hub tags](https://hub.docker.com/r/dxflrs/garage/tags), [Helm chart](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/branch/main-v2/script/helm/garage), [MinIO to Garage migration write-up](https://jacar.es/?p=7341)
- SeaweedFS: [repo](https://github.com/seaweedfs/seaweedfs), [CVE-2026-55874](https://vulert.com/vuln-db/CVE-2026-55874), [CVE-2026-55873](https://vulert.com/vuln-db/CVE-2026-55873), [CVE-2026-72920](https://advisories.gitlab.com/golang/github.com/seaweedfs/seaweedfs/CVE-2026-72920/)
- RustFS: [repo](https://github.com/rustfs/rustfs), [1.0 GA](https://aicybr.com/blog/rustfs-1-0-ga-s3-object-storage), [CVE-2025-68926](https://advisories.gitlab.com/pkg/cargo/rustfs/CVE-2025-68926/)
- Forks: [pgsty/minio "promise kept"](https://blog.vonng.com/en/db/minio-promise-kept/), [OpenMaxIO](https://feedbagel.com/post/openmaxio-community-maintained-fork-of-minio-object-storage-console), [Chainguard minio](https://images.chainguard.dev/directory/image/minio)
- Others: [versitygw](https://github.com/versity/versitygw), [Zenko CloudServer](https://hub.docker.com/r/zenko/cloudserver), [Ceph RAM planning](https://oneuptime.com/blog/post/2026-03-31-rook-ram-requirements-monitors-osds/view)

---

## Adversarial review (Opus)

**Reviewer:** Opus, 2026-10-04. I verified the codebase claims at file:line, checked the external claims against primary sources (deuxfleurs Gitea release API, GitHub repo/advisory API, registry APIs), and ran an empirical spike. **Docker is not installed on the review machine**, so I did not run the container image. I ran the **same release binaries natively** instead, extracted (not installed) from Homebrew bottles into the scratchpad: Garage `cargo:2.4.1 [bundled-libs, k2v, lmdb, metrics, sqlite]`, SeaweedFS 4.48, MinIO RELEASE.2025-10-15 as the migration source, and rclone 1.75.1. The S3 client was the repo's own `@aws-sdk/client-s3` 3.1110.0 with `forcePathStyle: true`. Container-only behaviour (image path, UID, bind mounts on Linux) is checked against the upstream Dockerfile, not observed.

### Verdict: **recommendation stands, with changes.**

The choice of Garage survives, and the spike made the case stronger. Garage passed every operation the app issues, and the metadata round-trip that idempotency depends on works. It sat at about 20 MiB RSS idle and 44 MiB after the spike, against 468 MiB for SeaweedFS and 415 MiB for MinIO measured in the same session. The SeaweedFS fallback looks *worse* than the proposal says. Several of the proposal's load-bearing premises are wrong, however, and so is its migration verification. The plan as written would ship a dev stack that crash-loops on every existing `.env`, and a migration check that cannot detect the failure it was written to catch.

### Spike results

Garage single-node config: `db_engine = "sqlite"`, `replication_factor = 1`, `rpc_bind_addr = 127.0.0.1:39101`, `[s3_api] s3_region = "us-east-1"`, `api_bind_addr = 127.0.0.1:39100`, `[admin] api_bind_addr = 127.0.0.1:39103`. Command: `garage -c garage.toml server --single-node --default-bucket` with `GARAGE_RPC_SECRET`, `GARAGE_DEFAULT_{ACCESS_KEY,SECRET_KEY,BUCKET}`.

| Test | Garage 2.4.1 | SeaweedFS 4.48 (`weed mini`) |
|---|---|---|
| Starts without `rpc_secret` | **No**: `rpc_secret value is missing` | n/a |
| `rpc_secret` format | **Exactly 64 hex** (32-hex and non-hex both rejected: "expected 32 bytes of random hex"). Rotating it on existing single-node data is harmless | n/a |
| Key ID `minioadmin` | **Accepted.** So did `AKIAIOSFODNN7EXAMPLE` and a 32-hex ID without `GK`. v2.3.0 notes: "relax requirements on imported access keys … transition from other S3 storage providers (#1262)" | Accepted |
| Secret `minioadmin` (10 chars) | **Rejected, fatal**: `Secret keys should be at least 16 characters long` | Accepted |
| Restart, same env | Idempotent: no error, bucket and key kept | Idempotent (`-bucket` creates only if missing) |
| Restart, **changed secret** | **Fatal, so a crash loop under `restart: unless-stopped`**: `Access key minioadmin is associated with a secret key different than the one given` | n/a |
| Restart, **changed key ID** | Starts and creates a *second* key. **The old key stays valid** | n/a |
| HeadBucket | 200 | 200 |
| PutObject + `Metadata{upload-sha256}` then HeadObject | Round-trips exactly, lower-case key, ContentType kept | Same |
| Overwrite replaces metadata (re-ship path) | Yes | Yes |
| GetObject bytes equal | Yes | Yes |
| HeadObject missing key | `NotFound`/404, `instanceof S3ServiceException`, so `lib/s3.ts:20-25` maps it to null | Same |
| 40 MiB single PUT (cap is 200 MB, `routes/transcripts.ts:18`) | OK | OK |
| ListObjectsV2 `MaxKeys:500`, prefix, 1202 keys | 3 pages, exact, no prefix leak | Same |
| DeleteObjects 1000 keys / incl. a missing key | 1000/0 errors; missing key reported Deleted | Same |
| `ServerSideEncryption: AES256` sent | **Accepted silently** | **Accepted silently** |
| Client region `garage` against server `us-east-1` | 400 (mismatch rejected, as the doc predicts) | Accepted (region-agnostic) |
| Wrong secret | 403 | 403 |
| `garage status` / `garage health` (2.4.0+) | exit 0 healthy, **exit 1** server down | n/a |
| Admin `GET :3903/health`, no token configured | 200 "Garage is fully operational", so an `httpGet` probe works for Helm | n/a |
| `rclone copy --metadata --immutable` MinIO→store, 300 transcripts + 20 rationales | 320/320, **300/300 `upload-sha256` intact** | 300/300 intact |
| Same copy **without** `--metadata` (control) | **0/300 metadata survive** | not run |
| `rclone check` / `check --download` on the metadata-stripped control | **"0 differences found"** | not run |
| RSS idle / after spike | 20 MiB / 44 MiB | 468 MiB after spike |

Also verified:

- **Pulls:** `quay.io/minio/minio` and `quay.io/minio/mc` return **401 to an anonymous pull token**, while a control (`quay.io/prometheus/node-exporter`) returns 200. `hub.docker.com/v2/repositories/minio/minio` returns **404**. The GitHub API shows `minio/minio` `archived: true`, last pushed 2026-04-24.
- **Garage image:** `dxflrs/garage:v2.4.1` is multi-arch (`arm64, amd64, 386, arm`). The upstream Dockerfile is `FROM scratch`, `COPY … /garage`, `CMD ["/garage","server"]`, so the binary path is `/garage`, there is no shell, and it runs as root.

### Findings

**BLOCKER 1. The credential premise is wrong, and the real constraint breaks every existing dev `.env`.**

- The doc's gotcha 2 says key IDs must be `GK…`. The spike says otherwise: any key ID is accepted, `minioadmin` included. The real constraint is a **secret of at least 16 characters**.
- Today `.env.example:26,37` ships `minioadmin`/`minioadmin`. Every developer's copied `.env` therefore hands Garage a 10-character secret, and Garage refuses to start.
- MinIO's minimum is 8 characters, so prod `MINIO_ROOT_PASSWORD` values of 8-15 characters (`.env.production.example:23`) break in the same way.
- Changing the secret after first boot is also fatal, which means a crash loop.
- Changing the key ID silently leaves the old key working. That is a revocation footgun.

Required:
- The preflight checks `len(secret) >= 16`, not a `GK` regex.
- Keep `minioadmin` as the dev key ID and change only the dev secret.
- Document rotation as `garage key delete <old>` plus an env change, not an env edit alone.
- Drop the "cannot reuse minioadmin" text from §0, §2.2, §4.3 and §8.2.

**BLOCKER 2. `rpc_secret` is mandatory and has a strict format. `<derived>` (§4.2) cannot be built in Compose.**

Compose interpolation has no hash function, and the secret must be exactly 64 hex. Required: ship a fixed, documented constant default **and** bind RPC to loopback inside the container (`rpc_bind_addr = "127.0.0.1:3901"`, `rpc_public_addr = "127.0.0.1:3901"`). The healthcheck `exec` still reaches it, as I did in the spike, and a public constant then grants nothing to other containers on the network. Without the loopback bind, a constant secret gives any container on the Compose network full cluster admin. Helm: generate the secret into the Secret with `randAlphaNum`-style hex and `lookup` it so it survives upgrades.

**BLOCKER 3. "Unverified" pull breakage is verified. `main` is broken for fresh installs today, and the plan has no bridge.**

- `just dev-infra-up` on a machine without a cached image cannot pull `minio` or `mc` (anonymous 401, confirmed against a working control).
- The migration script's default `MIGRATION_SOURCE_IMAGE` (§4.5 step 3) is that same unpullable image. The air-gapped mirror list (`docs/deploy/air-gapped.md:147`) and Helm's default image (`values.yaml:55-56`) fail the same way.
- `legacyMinio.enabled=true` (§4.5, Kubernetes) would schedule an unpullable StatefulSet.

Required: **split the release.**
1. Ship a `fix(deploy):` **patch now** that swaps the image to `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` and `pgsty/mc` (Docker Hub, amd64 and arm64, latest tag 2026-08-04; the proposal's "2026-04-17" is stale). This works on the same data directory with zero migration.
2. Ship Garage as the `feat(deploy)!:` major afterwards.
3. Make pgsty the default migration source and the default legacy-Helm image.

**MAJOR 1. The S3 inventory misses a second object family, and that breaks the migration check.**

What was missed:
- `apps/ingest/src/lib/judge-rationales.ts:30,83,141` writes `judge-rationales/{sessionId}/v{n}.json` (PutObject) and batch-deletes it. The prefix is deliberately outside `transcripts/` so the orphan sweep leaves it alone (`judge-rationales.ts:24-27`).
- Ingest also issues `GetObject` (`jobs/index-transcripts.ts:45`, which feeds index, judge, backfill and embed).
- `jobs/embed-transcripts.ts:171-179` builds its own `S3Client`.

Impact:
- §1.2's claim that GetObject happens only in web is wrong.
- The key-layout line is incomplete.
- **§4.5 step 6's three-count check (`objects == sessions with transcript_s3_key`) can never match** on any deployment that ran the judge. It must count `transcripts/` objects against `sessions.transcript_s3_key`, and `judge-rationales/` objects against `scores.rationale_ref`.

**MAJOR 2. The migration verification is blind to the one property it has to protect.**

The spike shows `rclone check`, with or without `--download`, reports "0 differences" on a copy that lost **all** user metadata, and the step 7 single-object spot check is a sample of one.

Required:
- Run `rclone lsjson -R -M` on source and destination and diff the `upload-sha256` field for every object. The output is diffable, as checked in the spike.
- Fail the script on any mismatch.
- Make `--metadata` non-optional in code, not only in prose.

Two side effects to note:
- rclone adds `mtime`/`btime` user metadata on the destination. This is harmless because the app reads only `upload-sha256`.
- The destination `LastModified` becomes the migration time.

**MAJOR 3. The SeaweedFS fallback is mis-assessed. `>= 4.34` is not a safe floor.**

The GitHub advisory API lists about 25 SeaweedFS advisories in roughly four months. Critical ones published *after* 4.34 include:
- 2026-09-18: "S3 gateway gRPC PutIdentity and RemoveIdentity accept unauthenticated requests"
- 2026-09-09: "Missing Authorization in seaweed-volume"
- 2026-09-12: "ArangoDB AQL Injection in S3 Listing…"
- 2026-09-23: "SFTP accepts an empty password…"
- 2026-09-11: an unauthenticated SSRF reaching IMDS

Several show no patched version. Separately, `weed mini` by default:
- runs the Admin UI with **auth disabled when `-admin.password` is empty** (its own `-h`);
- also opens Iceberg (:8181) and Lance (:9101) listeners, and Lance had a path-traversal advisory on 2026-09-18.

In SeaweedFS's favour, the spike confirms it accepts `minioadmin`/`minioadmin` and any region, so it has zero credential friction, and it has a UI.

Required:
- Restate the fallback as "latest release at implementation time, every non-S3 listener bound to loopback, admin password mandatory".
- Rewrite §2.3's CVE paragraph from the advisory list.
- This **strengthens** Garage as the default.

**MAJOR 4. §4.1 contradicts itself on the S3 port, and the compose sketch is incomplete.**

- The table row says container port 3900 and `S3_ENDPOINT=http://objectstore:3900`. The very next row says bind 9000.
- The §4.2 sketch has no `ports:` mapping and no `garage.toml` content.
- The spike shows `api_bind_addr` can be any port, so 9000 works.

Decide **9000**. Publish `${S3_PORT:-${MINIO_PORT:-9000}}:9000`, delete the 3900 row, and include the full `garage.toml` (sqlite, `replication_factor = 1`, region, loopback RPC, admin on 3903) in the doc.

**MAJOR 5. Renaming the Compose service is a break that the network alias does not cover.**

The `minio` alias covers DNS only. Anything that keys on the *service name* breaks once the service is renamed:
- user override files that set `minio:` (Compose then errors on a service with no image);
- `depends_on: minio`;
- `docker compose logs minio`.

The repo's own `docker-compose.traefik.yml:14` is one such reference. Either keep the service key `minio` for one major release, with a neutral `container_name`/comment, or list this explicitly in the breaking-change notes.

**MAJOR 6. The plan is over-engineered in Helm and in the migration script.**

Cut:
- `objectStore.legacyMinio.enabled` (its image is unpullable; see Blocker 3);
- the `migrate-minio` Job template;
- the three-image fallback chain.

Replace them with:
- `fail` when `minio.enabled=true`;
- a documented one-off `kubectl run rclone/rclone` recipe;
- a single pgsty source image.

Keep the Compose preflight: it is the one real data-loss guard. Note that it only protects users who go through `just`, so the README and deploy docs must say so.

**MINOR findings**

- **Lifecycle drop: verified safe, and agreed.**
  - App retention defaults to 365 days (`config.ts:138-139`).
  - The sweep is seeded as enabled (`scheduler.ts:347`).
  - The sweep honours team overrides up to `ORG_MAX_RETENTION_DAYS` = 730 (`config.ts:98`, `sweep-retention.ts:66-78`), and `0` means disabled.
  - The `mc ilm` rule (`docker-compose.infra.yml:62`) is bucket-wide. It therefore also expires `judge-rationales/` and silently overrides a team's 730 days or an operator's 0, leaving DB rows that point at 404s. The bug is real.
  - The only thing lost is a backstop for deployments that disabled the sweep. Say so in the release notes.
  - Do **not** reintroduce a store-side rule after migration: the copy resets `LastModified`, so it would restart every object's clock.
- **"Helm never creates the bucket": confirmed.** `templates/` has no bucket job; the only hits are `values.yaml:61,80` and `_helpers.tpl:117-121`. Default-bucket mode fixes it.
- **Healthcheck:** use `["CMD","/garage","health"]`. It was added in 2.4.0 and is verified at exit 0 healthy and 1 down; container env provides `GARAGE_RPC_SECRET` to the exec. For Helm, use `httpGet :3903/health` (verified unauthenticated 200). Pin `>= 2.4.0`, which also fixes DeleteObjects reporting missing keys (#1460).
- **SSE is silently accepted** by both Garage and SeaweedFS: no error, and no encryption is implied. Today `SECURITY.md:149-154` only warns MinIO users. Make it say that `S3_SSE_ALGORITHM` against the bundled store **does not encrypt**, and consider having ingest warn at startup when SSE is set and the endpoint is the bundled host.
- **Source corrections:**
  - RustFS has **35** GitHub advisories, not 12. GHSA rates CVE-2025-68926 *medium*, not critical. 1.0.0 (2026-09-16) is confirmed and 1.0.1 shipped on 2026-10-03.
  - Garage v2.2.0 is dated 2026-01-24, not 01-26. v2.3.0 (2026-04-16) is confirmed to add `--single-node`/`--default-*`, and 2.4.1 is dated 2026-09-08.
  - "Frequent releases" means about one minor per quarter.
  - Garage 2.3.0 also fixed "silent write errors (#1360)". That is a recent durability bug, which is one more reason the bundled store stays non-production.
- **No Prometheus or Grafana dependency on MinIO metrics** (`infra/prometheus/prometheus.yml` scrapes only the apps), so nothing to migrate there. The seed (`packages/db/src/seed.ts:41-49,931`) writes without `upload-sha256` metadata, which is harmless.
- **Breaking-change framing:** justified for the Garage step, because existing bundled-store data needs a copy. It is *not* needed for the immediate fix (Blocker 3), which should be a patch.

### Required changes before implementation

1. Split delivery: a `fix(deploy):` patch to pgsty images now, then Garage as `feat(deploy)!:`.
2. Rewrite the credential guidance around "secret of at least 16 characters, any key ID". Change the dev secret only, and document key rotation.
3. Ship a constant `rpc_secret` with loopback RPC bind in Compose, and a generated, `lookup`-persisted secret in Helm.
4. Fix the inventory (judge rationales, ingest GetObject, the embed client) and the migration counts per prefix.
5. Replace `rclone check` with a full `lsjson -M` metadata diff that is fatal on mismatch.
6. Resolve the port to 9000 and put the complete `garage.toml` in the doc.
7. Downgrade and requalify the SeaweedFS fallback: latest release, loopback non-S3 listeners, admin password required.
8. Keep the `minio` service key or call out the rename as breaking.
9. Cut the Helm legacy StatefulSet, the migrate Job and the image fallback chain.
10. Use the `garage health` / `:3903/health` probes and pin `>= 2.4.0`.
11. Add the SSE-is-a-no-op warning to `SECURITY.md`.

---

## Implementation review (Opus)

**Reviewer:** Opus, 2026-10-04, against the uncommitted Garage implementation in this worktree.

**Verdict: ship after the fixes below.** I applied all of them in the worktree.

Docker is still unavailable on the review machine. Everything marked *verified* ran natively, using the same release binaries as in the first review (Garage 2.4.1, MinIO RELEASE.2025-10-15, rclone 1.75.1), plus Helm v3.18.6 (the version CI uses) and Helm 4.3.0. Anything that only exists inside a container is listed under "Still unverified".

### Verified

- **Garage boots with the shipped config.** I ran `infra/garage/garage.toml` with only the paths and ports remapped (a diff confirmed nothing else changed), the exact compose command line (`garage -c … server --single-node --default-bucket`), and the compose defaults (`minioadmin` / `minioadmin-dev-secret` / `transcripts` / the 64-hex RPC constant):
  - It starts with `[admin]` set and no `admin_token`.
  - It creates the key and the bucket.
  - It listens on S3, plus RPC and admin on loopback only.
- **Healthcheck.** `garage -c <conf> health`, invoked exactly as the healthcheck does, exits 0. It exits 1 when `GARAGE_RPC_SECRET` is absent, and 1 when the server is down.
- **Admin API.** `/health` returns 200. `/v2/GetClusterStatus` returns 403 without a token. `/metrics` is open, but only on loopback.
- **Repo S3 client.** I drove the store with the repo's client from `apps/ingest`, using the env names compose passes to ingest. All 17 checks passed: HeadBucket, Put with metadata then Head, overwrite, Get, the 404 mapping, a 40 MiB PUT, judge-rationale PUT, ListV2 pagination, DeleteObjects ×1000, DeleteObject, SSE accepted, region mismatch → 400, wrong secret → 403.
- **Migration copy and verifier.** The script's rclone env-var remotes, `copy --metadata --immutable`, `lsjson -R -M --files-only`, then `scripts/verify-object-copy.ts`:
  - Real MinIO→Garage copy (300 transcripts + 20 rationales): **passes**. Extra destination objects are tolerated. rclone's `mtime`/`btime` are ignored, and `tier`/`content-type` match.
  - Copy made without `--metadata`: **fails** with "300 with differing size/metadata". `rclone check` passes that same broken copy.
- **Helm** (3.18.6 and 4.3.0):
  - lint and default render are clean.
  - external-S3 render emits no object-store resources.
  - `--set minio.enabled=false` fails with the migration pointer.
  - a short secret fails.
  - I ran the CI job steps locally and they pass.
  - The `lookup`-based `rpc-secret` persistence, simulated by substituting lookup results: an existing secret is reused, while an empty or missing key generates a new 64-hex value.
  - The bucket is created by default-bucket mode (verified above). The chart passes it through `GARAGE_DEFAULT_BUCKET` = `objectStore.bucket` = ingest's `S3_BUCKET`.
- **Compose interpolation** (verified from source, not executed). In compose-go `template/template.go`, `withDefaultWhenAbsence` substitutes the default lazily, only when the outer variable is unset or empty. So `${S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD:?msg}}` raises only when both are missing. `getFirstBraceClosingIndex` handles nesting, so `${S3_PORT:-${MINIO_PORT:-9000}}` resolves as intended.
- **Gates:**
  - `bun run check`: clean.
  - typecheck, build and test with `--filter='!@ai-agents-observability/hook'`: all pass (14 test tasks), and `bun run test:scripts` passes 4/4.
  - `@ai-agents-observability/hook#build` fails because `cargo` is not installed on this machine. This predates the change: `apps/hook` has no diff, and `scripts/build.ts` shells out to `cargo build`.

### Findings and fixes

- **MAJOR (fixed): the Compose data-loss guard could be bypassed.** It checked "`./data/garage` is non-empty", so it let the stack start in two cases where Garage held a partial or empty store while `/readyz` was green:
  - after a migration that died half-way;
  - after a single `docker compose up` run outside `just`.

  Fix: the migration script now writes `data/garage/.minio-migration-complete` only after verification passes. `scripts/check-object-store.sh` requires that marker whenever `./data/minio` has data. `OBJECT_STORE_ALLOW_EMPTY=1` records the decision in the same file, so it is needed only once. I tested 7 scenarios in a scratch tree: fresh clone, MinIO-only, half-migrated, allow-empty, after allow-empty, marker present, old short-secret `.env`.
- **MAJOR (fixed): Helm upgrades with default values silently lost data.** The `hasKey "minio"` check only catches users whose values file mentions `minio:`. An install on defaults would delete the MinIO StatefulSet, start an empty Garage, and orphan `data-<fullname>-minio-0`. Fix: `validate` now does a `lookup` of that PVC and fails unless `objectStore.legacyMinioPvcAcknowledged=true`. The flag is new in `values.yaml`, and the migration doc's upgrade step sets it. Verified by substituting the lookup result: the render fails, passes with the acknowledgement, and passes on external S3.
- **MINOR (fixed):**
  - `objectStore.enabled=false` without `externalS3.endpoint` rendered ingest pointing at a Service that does not exist. It now fails, and CI asserts that.
  - `scripts/verify-object-copy.test.ts` ran in no gate, because root `test` is only `turbo run test`. Root `test` now also runs `test:scripts`.
  - The env-file parser counted an unquoted trailing ` # comment` as part of the secret, which could false-pass the 16-character check. Unquoted comments are now stripped as Compose does; quoted values are left intact.
  - The migration doc understated disk space. It said 1× the old store; the real figure is about 2× (scratch source plus the new store).
  - The doc's PVC and Service names disagreed between steps. They now consistently use `<fullname>`.
  - `SECURITY.md` said "no secrets are hardcoded" while compose ships a fixed `GARAGE_RPC_SECRET`. It now documents that exception and the loopback bind that makes it safe.
- **MINOR (accepted, not changed):**
  - `assertNoLegacyMinioEnv` only fires when the legacy names are set *and* `S3_*` is missing. Those processes would have failed anyway, so it cannot break BYO-S3 or Helm, and it reads `process.env` only inside `loadConfig()`, as CLAUDE.md requires. Web has no equivalent; that is harmless.
  - Keeping the service key `minio`, with alias `objectstore`, is mildly confusing but is the compatible choice; it is documented in the compose comment and the runbook.
  - The prod overlay still always starts the bundled store, even for BYO-S3 users, and seeds it with whatever `S3_*` holds. This predates the change; the MinIO overlay did the same.
  - Renaming the runbook breaks the published site URL `docs/runbooks/minio-full`.
  - `s3_region` is fixed at `us-east-1` in `garage.toml`. This is documented.

### Still unverified (needs Docker or a cluster)

- The `dxflrs/garage:v2.4.1` container itself, including:
  - that the healthcheck exec sees `GARAGE_RPC_SECRET`;
  - root-owned bind mounts under `./data/garage` on Linux;
  - the `0.0.0.0:9000` bind behind the published port.
- `docker compose config` on the edited files, to confirm the interpolation behaves as the source reading says.
- The Docker-dependent half of `scripts/migrate-minio-to-garage.sh`: the `pgsty/minio` source on a `cp -a` scratch copy, the container networking, the running-container refusal, and cleanup of root-owned scratch files.
- `lookup` against a live API server, and the Kubernetes migration pod recipe.
