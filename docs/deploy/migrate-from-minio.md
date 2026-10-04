# Migrating the bundled object store from MinIO to Garage

**Who needs this:** anyone who ran the stack with the bundled MinIO (Docker Compose, `just ...`, or the Helm chart's `minio.*` values) and wants to keep their stored transcripts. Anyone on external S3 (`S3_ENDPOINT_OVERRIDE`, `externalS3.*`) only needs the small config notes at the end. A fresh install needs nothing from this page.

## Why

The MinIO community edition is archived upstream and its container images are no longer pullable (`quay.io/minio/minio` and `quay.io/minio/mc` return 401 to anonymous pulls, Docker Hub `minio/minio` is gone). The bundled store is now [Garage](https://garagehq.deuxfleurs.fr) (`dxflrs/garage`, single-node mode, one image, no init container, ~20 MiB RAM). Garage **cannot read MinIO's on-disk format**, so existing data must be copied. The application code and the `S3_*` variable names are unchanged, and Garage listens on container port 9000, so every `http://minio:9000` / `http://localhost:9000` endpoint keeps working.

The bundled store is for dev, homelab and small teams. Single-node Garage has no redundancy (same as the single-drive MinIO before it). For production-grade durability point the stack at a managed S3 service.

## What changes for you

| Before | After |
|---|---|
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (the old names still work as a fallback in the compose files; the apps never read them, and ingest fails with guidance if only the old names are set) |
| secret of any length (`minioadmin`) | **secret of at least 16 characters**. Garage refuses to start otherwise. Any key id is fine. |
| `MINIO_PORT`, `MINIO_CONSOLE_PORT` | `S3_PORT` (default 9000). There is no console. |
| `./data/minio` | `./data/garage` (`./data/minio` is left untouched) |
| bucket + 365-day expiry rule created by `createbuckets` | bucket created by Garage on start; **no store-side expiry rule** |
| Helm `minio.*` | Helm `objectStore.*` (setting `minio.*` fails the render) |
| compose service `minio` | **renamed to `object-store`** (it runs Garage). `minio` stays as a network alias, so `S3_ENDPOINT=http://minio:9000` keeps resolving; the new default endpoint is `http://object-store:9000`. |
| dev default credentials `minioadmin` / `minioadmin` | `devaccesskey` / `devsecretkey-change-me` (`.env.example`) |

**Compose override files.** The alias only covers DNS. If you have your own override file (or script) that references the `minio` *service* (`services: minio:`, `depends_on: minio`, `docker compose logs minio`, `exec minio ...`), rename it to `object-store`; otherwise Compose will error or create a stray service with no image. Prod overlay users: `docker-compose.traefik.yml` and the other shipped files are already updated.

**Dev credentials.** If your `.env` still has the old `minioadmin` / `minioadmin`, update **both** values (for example to `devaccesskey` / `devsecretkey-change-me`, or any key id and a 16+ character secret) before starting. The preflight rejects a secret under 16 characters. Do this *before* the first Garage start: Garage will not accept a changed secret for an existing key after first boot (it crash-loops). If Garage already started with other credentials, either restore those exact values in `.env`, run `/garage key delete <old key id>` in the `object-store` container and restart, or (dev only, nothing worth keeping in `./data/garage`) stop the stack and delete `./data/garage`, then re-run the migration.

**Retention behaviour change.** The old 365-day rule was bucket-wide: it also expired `judge-rationales/` objects and silently overrode per-team retention longer than 365 days (up to `ORG_MAX_RETENTION_DAYS`, default 730). Retention is now owned only by the app's `sweep-retention` job (`TRANSCRIPT_RETENTION_DAYS`, per-team overrides). If you had disabled that job and relied on the bucket rule as a backstop, re-enable the job. Do not add a store-side rule after migrating: the copy resets each object's `LastModified` and would restart every object's clock.

**Credentials are sticky.** After Garage has started once, never edit the secret alone (Garage crash-loops on a changed secret for an existing key id). Rotate by running `docker compose exec object-store /garage key delete <old key id>`, then changing the env. Changing only the key id leaves the old key valid.

**SSE.** Garage accepts `S3_SSE_ALGORITHM` headers but does not encrypt. See [SECURITY.md](../../SECURITY.md).

## Docker Compose / `just`

1. **Stop the stack** so nothing writes during the copy: `just prod-down` (or `just dev-down` / `just dev-infra-down`).
2. **Update your env file** (`.env` or `.env.production`; compare with `.env.example` / `.env.production.example`): set `S3_ACCESS_KEY_ID` and a `S3_SECRET_ACCESS_KEY` of at least 16 characters. Migrating with your existing MinIO password is fine if it is already 16+ characters; the old credentials of the *old* MinIO are read from `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` in the same file (or `OLD_MINIO_USER` / `OLD_MINIO_PASSWORD`), so leave them in place until the migration succeeds.
3. **Run the migration** (needs `docker` and `bun`; free disk of about **twice** the size of `./data/minio`: one copy for the scratch source, removed afterwards, and one for the new `./data/garage`):

   ```bash
   just migrate-object-store .env.production      # or: ./scripts/migrate-minio-to-garage.sh .env.production
   ```

   What it does: serves a **copy** of `./data/minio` from the `pgsty/minio` image (the community MinIO build that is still pullable; override with `MIGRATION_SOURCE_IMAGE`), starts Garage on the real `./data/garage`, and runs `rclone copy --metadata --immutable` between them. It is restartable: re-running skips what was already copied. `./data/minio` is never modified or deleted.
4. **Read the verification output.** The script diffs `rclone lsjson -R -M` listings of both sides and fails on any object that is missing or whose size or user metadata differs. It deliberately does **not** use `rclone check`, which reports "0 differences" even on a copy that lost all metadata. The `upload-sha256` metadata is what makes transcript re-shipping idempotent.
5. **Cross-check with the database.** The store holds two object families, so total objects are not the session count:
   - `transcripts/...` should line up with `SELECT count(*) FROM sessions WHERE transcript_s3_key IS NOT NULL;`
   - `judge-rationales/...` should line up with `SELECT count(DISTINCT rationale_ref) FROM scores WHERE rationale_ref IS NOT NULL;`

   The script prints per-prefix counts. Investigate any other gap before deleting anything.
6. **Start the stack** with `just prod-up` (or `dev-up` / `dev-infra-up`).
7. After you are satisfied, remove `./data/minio` yourself and delete `MINIO_*` from your env files.

**The guard only covers `just`.** `just dev-up`, `prod-up` and the other start recipes refuse to run (clear error, points here) if `./data/minio` has data and no completed migration is recorded (the script writes `./data/garage/.minio-migration-complete` only after the copy verifies, so a half-finished run does not count), because otherwise Garage would start empty, `/readyz` would be green, and database rows would point at keys that 404. Running `docker compose up` or `bun run docker:*` directly bypasses that check. Set `OBJECT_STORE_ALLOW_EMPTY=1` once to start empty on purpose; that is recorded in the same marker file.

**Rollback.** `./data/minio` is untouched. Check out the previous release, and run the old stack with an image you can still obtain (for example `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` set as the `minio` service image); it works on the same directory with no migration.

**Troubleshooting.** `could not copy ./data/minio`: files are root-owned, re-run with `sudo` or set `MIGRATION_SOURCE_INPLACE=1` (mounts read-only, no scratch copy; MinIO may refuse to start on a read-only volume). `the old MinIO did not start`: wrong old credentials, set `OLD_MINIO_USER` / `OLD_MINIO_PASSWORD`. Region: the shipped Garage config uses `us-east-1`; if you set a different `S3_REGION`, change `s3_region` in `infra/garage/garage.toml` to match.

## Kubernetes (Helm)

If you already use external S3 (`minio.enabled=false`, the production recommendation): rename `minio.enabled: false` to `objectStore.enabled: false` in your values and nothing else changes. Otherwise:

1. **Scale writers down and upgrade** so the new Garage StatefulSet comes up empty and the bucket is created:

   ```bash
   helm upgrade <release> <chart> -f my-values.yaml \
     --set ingest.replicaCount=0 --set web.replicaCount=0 \
     --set objectStore.legacyMinioPvcAcknowledged=true
   ```

   In `my-values.yaml`, replace the `minio:` block with `objectStore:` (`auth.accessKeyId`, `auth.secretAccessKey` of at least 16 characters, `bucket`). Without `objectStore.legacyMinioPvcAcknowledged=true` the upgrade **fails on purpose** while the old MinIO PVC exists, so that an upgrade with default values cannot silently start an empty store. Helm removes the old `<fullname>-minio` StatefulSet but **keeps its PVC** (`data-<fullname>-minio-0`, where `<fullname>` is usually `<release>-ai-agents-observability`). Snapshot that PVC first if your storage class supports it: step 2 mounts it read-write and MinIO rewrites its metadata directory on start.
2. **Copy** with a one-off pod: the old data served by `pgsty/minio`, plus an `rclone` container in the same pod (shared localhost):

   ```bash
   kubectl apply -f - <<'YAML'
   apiVersion: v1
   kind: Pod
   metadata: {name: minio-migrate}
   spec:
     restartPolicy: Never
     containers:
       - name: src
         image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z
         args: [server, /data]
         env: [{name: MINIO_ROOT_USER, value: minioadmin}, {name: MINIO_ROOT_PASSWORD, value: <old password>}]
         volumeMounts: [{name: old, mountPath: /data}]
       - name: rclone
         image: rclone/rclone:1.75.1
         command: [sleep, "86400"]
         env:
           - {name: RCLONE_CONFIG_SRC_TYPE, value: s3}
           - {name: RCLONE_CONFIG_SRC_PROVIDER, value: Minio}
           - {name: RCLONE_CONFIG_SRC_ENDPOINT, value: "http://localhost:9000"}
           - {name: RCLONE_CONFIG_SRC_ACCESS_KEY_ID, value: minioadmin}
           - {name: RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY, value: <old password>}
           - {name: RCLONE_CONFIG_DST_TYPE, value: s3}
           - {name: RCLONE_CONFIG_DST_PROVIDER, value: Other}
           - {name: RCLONE_CONFIG_DST_ENDPOINT, value: "http://<fullname>-object-store:9000"}
           - {name: RCLONE_CONFIG_DST_ACCESS_KEY_ID, value: <new key id>}
           - {name: RCLONE_CONFIG_DST_SECRET_ACCESS_KEY, value: <new secret>}
           - {name: RCLONE_CONFIG_DST_REGION, value: us-east-1}
     volumes:
       - {name: old, persistentVolumeClaim: {claimName: data-<fullname>-minio-0}}
   YAML
   kubectl exec minio-migrate -c rclone -- rclone copy --metadata --immutable src:transcripts dst:transcripts
   ```

   Substitute the real service and PVC names (`kubectl get svc,pvc`).
3. **Verify** with the same diff the Compose script uses (not `rclone check`):

   ```bash
   kubectl exec minio-migrate -c rclone -- rclone lsjson -R -M --files-only src:transcripts > src.json
   kubectl exec minio-migrate -c rclone -- rclone lsjson -R -M --files-only dst:transcripts > dst.json
   bun run scripts/verify-object-copy.ts src.json dst.json
   ```

   Then do the database cross-check from the Compose section.
4. `kubectl delete pod minio-migrate`, scale ingest and web back up (`helm upgrade` without the `replicaCount=0` overrides; keep `objectStore.legacyMinioPvcAcknowledged=true` in your values until you delete the old PVC), and delete the old PVC when you are satisfied.

## External S3 users

No data migration. Env-file users: nothing to change. Helm users: `minio.enabled=false` becomes `objectStore.enabled=false`. In every case remember that `S3_SSE_ALGORITHM` works only on real S3, and drop `MINIO_*` variables from your env files.
