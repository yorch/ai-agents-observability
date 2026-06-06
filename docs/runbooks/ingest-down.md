# Runbook: Ingest Service Down

**Service**: `apps/ingest` (port 4000)  
**SLO**: 99.5% availability · p99 < 200ms

---

## Symptoms
- Hook clients get connection refused or 5xx responses
- Events stop arriving in the `events` Timescale table
- Sessions remain stuck in `status=active` past their normal session duration

## Diagnosis

```bash
# 1. Check container health
docker compose ps ingest

# 2. Tail recent logs
docker compose logs --tail=200 ingest

# 3. Hit the health endpoint (should return 200)
curl -sf http://localhost:4000/health | jq .

# 4. Hit the readiness endpoint — shows DB + S3 checks
curl -sf http://localhost:4000/readyz | jq .
```

### Common causes

| Cause | Signal | Fix |
|---|---|---|
| DB unreachable | readyz shows `postgres: error` | See [timescale-slow runbook](./timescale-slow.md) |
| S3 unreachable | readyz shows `s3: error` | See [minio-full runbook](./minio-full.md) |
| OOM killed | `docker stats` shows memory near limit | Increase container memory limit; identify event burst via session logs |
| Crash on startup | Logs show `Error:` before first `ingest service started` | Usually env var missing — check `.env` against `.env.example` |
| Port conflict | `address already in use` in logs | Kill the conflicting process on port 4000 |

## Mitigation

```bash
# Restart the service (graceful SIGTERM → 10s drain)
docker compose restart ingest

# Force restart if stuck
docker compose kill ingest && docker compose up -d ingest

# Scale back up if using multiple replicas
docker compose up -d --scale ingest=2
```

Hook clients retry with exponential backoff and have a local SQLite queue that survives restarts — events are not lost during a brief outage. The local queue capacity is unbounded for offline periods.

## Escalation
- P2 (within 4h): 1+ hours of no events from any hook client
- P1 (within 1h): queue drain after outage stalls (events arriving but not persisting to DB)
