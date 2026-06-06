# Runbook: GitHub Webhooks Failing

**Service**: `apps/github-app` (port 4001)  
**Impact**: PR rollups stale; PR bot comments not posted; session↔PR links missing

---

## Symptoms
- `webhook_deliveries` table shows `status='error'` rows
- GitHub App → Deliveries page shows failures (red ✕)
- PR rollups not updating after sessions complete
- PR bot comments absent on merged PRs

## Diagnosis

```bash
# 1. Check github-app service health
docker compose ps github-app
curl -sf http://localhost:4001/health | jq .

# 2. Recent error logs
docker compose logs --tail=200 github-app | grep -i error

# 3. Delivery failures in DB (last 24h)
psql $DATABASE_URL -c "
  SELECT event_type, action, repo, status, error_text, received_at
  FROM webhook_deliveries
  WHERE received_at > NOW() - INTERVAL '24 hours'
    AND status = 'error'
  ORDER BY received_at DESC
  LIMIT 20;"

# 4. Check GitHub App Deliveries tab for the HTTP response code
#    GitHub → Settings → Apps → <your app> → Advanced → Recent Deliveries
```

### Common causes

| Cause | Signal | Fix |
|---|---|---|
| Webhook secret mismatch | `400 Invalid signature` in logs | Verify `GITHUB_APP_WEBHOOK_SECRET` matches app settings |
| github-app service down | 5xx on delivery | See [ingest-down runbook](./ingest-down.md) pattern |
| Private key wrong | `JWT authentication failed` | Re-base64-encode PEM; update `GITHUB_APP_PRIVATE_KEY_B64` |
| App not installed on repo | Deliveries not arriving | Install app on the org/repo from GitHub App settings |
| Smee proxy expired (local dev) | No deliveries reaching service | Restart smee: `npx smee-client --url <smee-url> --path /webhooks/github --port 4001` |
| DB unreachable | `Failed to upsert PR` in logs | See [timescale-slow runbook](./timescale-slow.md) |

## Mitigation

### Redeliver a failed webhook
1. Go to GitHub App → Advanced → Recent Deliveries
2. Find the failed delivery
3. Click "Redeliver"

This is safe — PR upserts are idempotent (`ON CONFLICT DO UPDATE`).

### Backfill missing PR data
If deliveries were lost during an outage, trigger a backfill from the ingest side:
```bash
# In the ingest service, the team sync job runs `session-pr-linking` for open sessions.
# Force-run it by inserting a job trigger row (manual operational escape hatch).
psql $DATABASE_URL -c "
  INSERT INTO job_runs (job_name, started_at, status)
  VALUES ('pr-backfill-manual', NOW(), 'triggered');"
```

### Validate webhook signature locally
```bash
PAYLOAD='{"action":"opened"}'
SECRET="$GITHUB_APP_WEBHOOK_SECRET"
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print "sha256="$2}')
echo $SIG   # compare with X-Hub-Signature-256 header from GitHub delivery
```

## Escalation
- P3: Webhook delivery failures for > 2 hours (rollups stale but not broken)
- P2: github-app service completely down
