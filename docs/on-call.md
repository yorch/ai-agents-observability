# On-Call Guide

**Service**: ai-agents-observability  
**Current on-call owner**: Dev Tools team  
**Target handoff**: Platform/SRE at Phase 4 completion

---

## Rotation

| Period | Primary | Secondary |
|---|---|---|
| Phase 1–3 | Dev Tools team | N/A (dev-tool team owns recovery) |
| Phase 4+ | Platform/SRE | Dev Tools team (escalation) |

Update this table when rotation is set up in your incident management tool (PagerDuty / Opsgenie).

---

## Response Time Expectations

| Priority | Response | Mitigation target |
|---|---|---|
| P1 — Data integrity / GDPR | 15 minutes | 1 hour |
| P2 — Service degraded | 1 hour | 4 hours |
| P3 — Non-critical degradation | 4 hours (business hours) | Next business day |

**P1 examples**: Postgres unrecoverable; `run-deletions` job fails 2× consecutively; user data leak suspected.  
**P2 examples**: Ingest down > 1h; OAuth broken; webhook delivery error rate > 10%.  
**P3 examples**: Continuous aggregate refresh stale > 6h; PR bot comments delayed; transcript FTS returning no results.

---

## First 5 Minutes Checklist

```bash
# 1. Check all containers
docker compose ps

# 2. Check all health endpoints
for svc in ingest:4000 web:3000 github-app:4001; do
  curl -sf "http://localhost:${svc##*:}/health" || echo "$svc UNHEALTHY"
done

# 3. Check recent job failures
psql $DATABASE_URL -c "
  SELECT job_name, status, started_at, error_text
  FROM job_runs
  WHERE started_at > NOW() - INTERVAL '24 hours'
    AND status = 'error'
  ORDER BY started_at DESC;"

# 4. Check ingest error rate (last 5 min)
docker compose logs --since=5m ingest | grep -c '"status":5'
```

---

## Runbooks

| Scenario | Runbook |
|---|---|
| Ingest service down | [docs/runbooks/ingest-down.md](./runbooks/ingest-down.md) |
| MinIO / S3 full or unreachable | [docs/runbooks/minio-full.md](./runbooks/minio-full.md) |
| TimescaleDB slow or unreachable | [docs/runbooks/timescale-slow.md](./runbooks/timescale-slow.md) |
| OAuth login broken | [docs/runbooks/oauth-broken.md](./runbooks/oauth-broken.md) |
| GitHub webhooks failing | [docs/runbooks/webhook-failing.md](./runbooks/webhook-failing.md) |

---

## Key Config Reference

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | All services | Postgres connection string |
| `S3_ENDPOINT` | ingest | MinIO / S3 endpoint |
| `S3_BUCKET` | ingest | Transcript bucket name |
| `TRANSCRIPT_RETENTION_DAYS` | ingest | Days to keep transcripts (default: 365) |
| `GITHUB_APP_PRIVATE_KEY_B64` | github-app | App private key (base64 PEM) |
| `GITHUB_APP_WEBHOOK_SECRET` | github-app | Webhook HMAC secret |
| `GITHUB_HOST` | all | github.com or GHES host URL |
| `GITHUB_OAUTH_CLIENT_ID` | web | OAuth App client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | web | OAuth App client secret |

Full variable reference: `.env.example`

---

## Incident Communication

1. **Acknowledge in the incident channel** (`#ai-agents-obs-incidents`) within response time.
2. **Status updates** every 30 minutes on P1, every 2 hours on P2.
3. **Post-mortem** for P1 and any P2 that burned > 10% error budget: use `docs/post-mortems/YYYY-MM-DD-<slug>.md` template.
4. **GDPR incidents** (user data accessed without authorization, deletion failed): notify privacy@yourorg.com within 1 hour regardless of time of day.

---

## Escalation Path

1. Primary on-call
2. Secondary on-call (page after 15 min unacknowledged)
3. Dev Tools team lead (P1 only, page after 30 min)
4. Engineering manager (P1 data integrity only)
