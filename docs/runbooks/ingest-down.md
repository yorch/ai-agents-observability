# Runbook: Ingest Service Down

## Symptoms

- `POST /v1/events` or `POST /v1/transcripts` returning 5xx or timing out.
- Hook CLIs on developer machines reporting delivery failures / queuing events locally.
- `GET /health` on `apps/ingest` not returning `{"ok":true}`.

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

```
Grafana: http://localhost:3001 (see on-call.md)
```

Key panels to check on the **Ingest Service** dashboard:

- Error Rate (5xx) — spike indicates handler failures.
- p99 Latency — high values suggest DB or S3 saturation.
- Ingest QPS — sudden drop to 0 with expected traffic is a signal the service is down.

**Logs:**

```bash
# Docker Compose stack
bun run docker:app:logs
# or filter to ingest only
docker compose -f docker-compose.app.yml logs -f ingest
```

**Health check:**

```bash
curl http://localhost:4000/health
curl http://localhost:4000/readyz
```

`/readyz` reports `checks.postgres` and `checks.s3` individually — use this to isolate the failing dependency.

## Diagnose

1. **Service process exited?** — Check Docker exit code. OOM kills show exit code 137.
2. **Postgres down?** — `checks.postgres: "error"` in `/readyz`. See `timescale-slow.md`.
3. **MinIO/S3 down?** — `checks.s3: "error"` in `/readyz`. See `minio-full.md`.
4. **Config missing?** — Service fails at startup with a Zod validation error. Check env vars against `.env.example`.
5. **Port conflict?** — Default port 4000. `lsof -i :4000` to find the occupying process.

## Mitigate

- Restart the service: `docker compose -f docker-compose.app.yml restart ingest`
- If DB is the cause, the hook CLI queues events locally (SQLite) — no data loss for up to the local queue TTL.
- If S3 is the cause, transcript uploads fail but event ingestion continues (they are independent routes).

## Escalate

If the service cannot be restored within 30 min, or if DB corruption is suspected, escalate to the team lead. See [on-call.md](../on-call.md) for the escalation path.
