# Runbook: TimescaleDB Slow / Down

## Symptoms

- `POST /v1/events` latency elevated (p99 > 500 ms) or returning 500.
- `GET /readyz` on ingest shows `checks.postgres: "error"`.
- DB connection pool exhausted — log lines: `ingest.unhandled_error` with `PrismaClientKnownRequestError`.
- Hypertable chunk creation lagging.

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

```
Grafana: http://localhost:3001 (see on-call.md)
```

Key panels:

- p50 / p99 Latency — sustained elevation points to DB saturation, not transient spikes.
- Error Rate (5xx) — correlate with DB error logs.

**Logs:**

```bash
docker compose -f docker-compose.infra.yml logs -f postgres
bun run docker:app:logs   # ingest logs for DB error messages
```

**Connect directly:**

```bash
docker compose -f docker-compose.infra.yml exec postgres \
  psql -U postgres -d ai_agents_observability
```

## Diagnose

1. **Blocking queries?**

   ```sql
   SELECT pid, wait_event_type, wait_event, query, now() - query_start AS age
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY age DESC;
   ```

2. **Lock contention?**

   ```sql
   SELECT * FROM pg_locks l JOIN pg_stat_activity a ON l.pid = a.pid
   WHERE NOT l.granted;
   ```

3. **Hypertable chunk maintenance?** — TimescaleDB background jobs (compression, retention) can spike I/O. Check `timescaledb_information.job_stats`.

4. **Disk full?** — Check volume usage. Retention policy should keep the `events` hypertable bounded.

5. **OOM?** — `docker stats` — if Postgres is hitting its memory limit, it may crash + restart.

## Mitigate

- Kill a blocking query: `SELECT pg_terminate_backend(<pid>);`
- Restart Postgres (last resort — will briefly interrupt all services): `docker compose -f docker-compose.infra.yml restart postgres`
- Ingest events are idempotent (`ON CONFLICT DO NOTHING`) — hook CLIs will re-deliver on retry.
- If the volume is full, increase storage or run the retention sweep manually.

## Escalate

If the DB volume is corrupted or data loss is suspected, escalate immediately to the team lead. See [on-call.md](../on-call.md).
