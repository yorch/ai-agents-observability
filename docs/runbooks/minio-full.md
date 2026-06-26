# Runbook: MinIO / S3 Full or Unavailable

## Symptoms

- `POST /v1/transcripts` returning 500 or 503.
- `GET /readyz` on ingest shows `checks.s3: "error"`.
- MinIO console (`http://localhost:9001`) unreachable.
- Disk usage on the MinIO volume approaching capacity.

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

```
Grafana: http://localhost:3001 (see on-call.md)
```

Check the **Ingest Service** dashboard:

- Transcripts Stored (total) — if counter stopped incrementing, S3 writes are failing.
- Error Rate (5xx) — elevated errors on `/v1/transcripts` route.

**MinIO Console (local):** http://localhost:9001 (credentials: `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`)

**Check disk usage (local):**

```bash
docker system df
du -sh ./data/minio
```

## Diagnose

1. **Bucket missing?** — The `createbuckets` init container creates the `transcripts` bucket on first boot. If it failed, re-run: `docker compose -f docker-compose.infra.yml run --rm createbuckets`.
2. **Credentials wrong?** — Compare `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` in your `.env`.
3. **Volume full?** — Expand the volume or free space. In prod (real S3), check bucket quota/billing limits.
4. **MinIO container crashed?** — `docker compose -f docker-compose.infra.yml ps minio` — restart if exited.
5. **Network partition?** — Ingest container can't reach MinIO. Check Docker network: `docker network inspect`.

## Mitigate

- Transcript uploads fail independently of event ingestion — the service degrades gracefully.
- Restart MinIO: `docker compose -f docker-compose.infra.yml restart minio`
- If disk is full: remove confirmed orphan objects after identifying them, or expand the filesystem that backs `./data/minio`.
- Lifecycle rules: the bucket is configured for 365-day expiry. Verify with `mc ilm rule ls local/transcripts`.

## Escalate

Data loss risk if the MinIO volume is corrupted. Escalate to the team lead immediately. See [on-call.md](../on-call.md).
