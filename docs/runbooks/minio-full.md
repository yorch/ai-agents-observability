# Runbook: MinIO / S3 Storage Full or Unreachable

**Affects**: transcript uploads (ingest `/v1/transcripts`), transcript downloads (web `/api/me/transcripts`)

---

## Symptoms
- `ingest` readyz shows `s3: error`
- Transcript uploads return 500
- Web transcript viewer shows download errors
- `sweep-retention` or `run-deletions` jobs log S3 errors

## Diagnosis

```bash
# MinIO health check (local dev / homelab)
curl -sf http://localhost:9000/minio/health/live

# Check disk usage of the MinIO volume
docker exec $(docker ps -qf name=minio) df -h /data

# List bucket contents (count + total size)
docker exec $(docker ps -qf name=minio) mc ls --recursive --summarize minio/ai-agents-observability

# Recent error logs
docker compose logs --tail=200 minio
```

### Common causes

| Cause | Signal | Fix |
|---|---|---|
| Disk full | `df -h` shows 100% | Clear orphan objects; expand volume; enable lifecycle policy |
| Wrong credentials | `AccessDenied` in ingest logs | Rotate `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` |
| Bucket doesn't exist | ingest boot fails with `NoSuchBucket` | `mc mb minio/ai-agents-observability` |
| Network partition | TCP timeout from ingest to MinIO | Check docker network; restart both containers |

## Mitigation

### Free space immediately
```bash
# 1. Run the retention sweep job manually (triggers async, check job_runs table)
#    In a psql session:
INSERT INTO job_runs (job_name, status) VALUES ('sweep-retention-manual', 'triggered');

# 2. Or directly via mc: delete objects older than TRANSCRIPT_RETENTION_DAYS
docker exec $(docker ps -qf name=minio) mc rm --recursive --force \
  --older-than $(( ${TRANSCRIPT_RETENTION_DAYS:-365} * 24 ))h \
  minio/ai-agents-observability/transcripts/
```

### Bucket lifecycle policy (set once on clean install)
```bash
# Automatically expire objects > 1 year
docker exec $(docker ps -qf name=minio) mc ilm add \
  --expiry-days ${TRANSCRIPT_RETENTION_DAYS:-365} \
  minio/ai-agents-observability
```

### Expand MinIO volume
The production MinIO is configured with a named Docker volume. To expand:
1. Back up the volume: `docker run --rm -v minio_data:/data -v $(pwd):/backup alpine tar czf /backup/minio-backup.tar.gz /data`
2. Provision a larger disk
3. Restore: `docker run --rm -v minio_new:/data -v $(pwd):/backup alpine tar xzf /backup/minio-backup.tar.gz -C /`
4. Update the volume mount in `docker-compose.prod.yml`

## Escalation
- P2: ingest cannot write transcripts for > 30 minutes
- P1: MinIO disk > 95% (imminent risk of complete failure)
