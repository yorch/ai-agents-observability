# Runbook: TimescaleDB Slow or Unreachable

**Service**: `postgres` (Timescale HA image, port 5432)  
**Impact**: All services (ingest, web, github-app) depend on Postgres

---

## Symptoms
- Ingest readyz shows `postgres: error`
- Web pages time out on session queries
- Job runs stall without completing (check `job_runs` table)
- Events insert rate drops below baseline

## Diagnosis

```bash
# 1. Container health
docker compose ps postgres

# 2. Postgres connectivity
docker exec $(docker ps -qf name=postgres) psql -U postgres -c "SELECT version();"

# 3. Long-running queries (> 30s)
docker exec $(docker ps -qf name=postgres) psql -U postgres -c "
  SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
  FROM pg_stat_activity
  WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
    AND state <> 'idle'
  ORDER BY duration DESC;"

# 4. Table bloat on sessions
docker exec $(docker ps -qf name=postgres) psql -U postgres -c "
  SELECT
    pg_size_pretty(pg_total_relation_size('sessions')) AS sessions_total,
    pg_size_pretty(pg_total_relation_size('events')) AS events_total;"

# 5. Replication lag (if Timescale HA is running a replica)
docker exec $(docker ps -qf name=postgres) psql -U postgres -c "
  SELECT * FROM pg_stat_replication;"

# 6. Timescale chunk info
docker exec $(docker ps -qf name=postgres) psql -U postgres -c "
  SELECT chunk_name, range_start, range_end, is_compressed
  FROM timescaledb_information.chunks
  WHERE hypertable_name = 'events'
  ORDER BY range_start DESC
  LIMIT 10;"
```

## Mitigation

### Kill a runaway query
```sql
-- Get PID from long-running queries above
SELECT pg_cancel_backend(<pid>);   -- graceful
SELECT pg_terminate_backend(<pid>); -- forceful
```

### Boost compression (reduces I/O for old chunks)
```sql
SELECT compress_chunk(i.chunk_schema || '.' || i.chunk_name)
FROM timescaledb_information.chunks i
WHERE i.hypertable_name = 'events'
  AND NOT i.is_compressed
  AND i.range_end < NOW() - INTERVAL '7 days';
```

### Missing indexes (if a specific query is slow)
```sql
EXPLAIN ANALYZE <slow query here>;
-- Look for Seq Scan on events or sessions; add targeted index if confirmed
```

### Out-of-disk (Timescale uses named volume)
Same as [MinIO full runbook](./minio-full.md) pattern — expand the named volume, not the bind mount.

### Restart Postgres
```bash
# Graceful restart (waits for in-flight transactions)
docker compose restart postgres

# If restart fails, full cycle
docker compose stop postgres
docker compose start postgres
```

## Escalation
- P2: Any app returns 503 for > 5 minutes due to DB unreachable
- P1: Primary Postgres container exits unexpectedly (data loss risk — check WAL)
