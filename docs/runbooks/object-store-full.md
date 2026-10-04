# Runbook: Object Store (S3) Full or Unavailable

The bundled store is single-node [Garage](https://garagehq.deuxfleurs.fr) (compose service `object-store`, network alias `minio`; container port 9000). It has no console. If you run against external S3 (`S3_ENDPOINT_OVERRIDE` / `externalS3.*`), skip the Garage-specific steps and use your provider's tooling. Formerly `minio-full.md`.

## Symptoms

- `POST /v1/transcripts` returning 500 or 503.
- `GET /readyz` on ingest shows `checks.s3: "error"`.
- The object-store container is restarting, or `docker compose ps object-store` shows it unhealthy.
- Disk usage under `./data/garage` approaching capacity.

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

Check the **Ingest Service** dashboard:

- Transcripts Stored (total) — if counter stopped incrementing, S3 writes are failing.
- Error Rate (5xx) — elevated errors on `/v1/transcripts` route.

**Garage CLI (local).** The image has no shell, so run the binary directly:

```bash
docker compose -f docker-compose.infra.yml exec object-store /garage -c /etc/garage.toml status
docker compose -f docker-compose.infra.yml exec object-store /garage -c /etc/garage.toml health   # exit 0 up, 1 down
docker compose -f docker-compose.infra.yml exec object-store /garage -c /etc/garage.toml bucket info transcripts
docker compose -f docker-compose.infra.yml exec object-store /garage -c /etc/garage.toml stats
```

**Check disk usage (local):**

```bash
docker system df
du -sh ./data/garage
```

Transcripts are small and numerous: prefer XFS for the filesystem under `./data/garage` (ext4 can run out of inodes at very large object counts).

## Diagnose

1. **Container crash-looping?** — `docker compose -f docker-compose.infra.yml logs --tail 50 object-store`. Known fatal causes:
   - `Secret keys should be at least 16 characters long` — `S3_SECRET_ACCESS_KEY` is too short (the old dev default `minioadmin` is). Set a longer one.
   - `Access key ... is associated with a secret key different than the one given` — the secret was edited after first boot. Restore the old secret, or delete the key first (`/garage ... key delete <key id>`) and restart.
2. **Bucket missing?** — The store creates the `S3_BUCKET` bucket and key on every start (single-node default-bucket mode; idempotent). Restart it: `docker compose -f docker-compose.infra.yml restart object-store`, then check `bucket info` above.
3. **Credentials wrong (403)?** — Compare the effective `S3_*` credentials in the app containers with `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in `.env` (development) or `.env.production` (production). Changing only the key **id** leaves the old key valid; revoke it with `key delete`.
4. **Region error (`Authorization header malformed`)?** — `S3_REGION` must equal `s3_region` in `infra/garage/garage.toml` (default `us-east-1`).
5. **Volume full?** — Expand the volume or free space. In prod (real S3), check bucket quota/billing limits.
6. **Data after an upgrade from MinIO is missing?** — You started Garage without migrating `./data/minio`. Stop the stack and follow [migrate-from-minio.md](../deploy/migrate-from-minio.md); nothing was deleted.
7. **Network partition?** — Ingest container can't reach the store. Check Docker network: `docker network inspect`.

## Mitigate

- Transcript uploads fail independently of event ingestion — the service degrades gracefully.
- Restart the store: `docker compose -f docker-compose.infra.yml restart object-store`
- If disk is full: remove confirmed orphan objects after identifying them, or expand the filesystem that backs `./data/garage`.
- Retention is owned by the app (`sweep-retention`: `TRANSCRIPT_RETENTION_DAYS`, per-team overrides, `ORG_MAX_RETENTION_DAYS`). The bundled store has **no** bucket expiry rule; do not add one (it would also expire `judge-rationales/` and override team retention).

## Escalate

Data loss risk if `./data/garage` is corrupted (metadata is sqlite; back it up with the data directory while the store is stopped, or use filesystem snapshots). Escalate to the team lead immediately. See [on-call.md](../on-call.md).
