# Runbook: GitHub Webhook Failing

## Symptoms

- GitHub PR comments (bot summaries) not appearing.
- GitHub App settings → Recent Deliveries showing failed deliveries (non-2xx responses).
- `apps/github-app` logs: `webhook.signature.invalid`, `webhook.handler.error`, or request timeouts.
- Session ↔ PR linking not completing (PR rollup data stale).

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

```
Grafana: http://localhost:3001 (see on-call.md)
```

There are no dedicated webhook metrics yet (P2-009 tracks adding them). For now rely on GitHub delivery logs and service logs.

**GitHub delivery log:** GitHub App settings → Advanced → Recent Deliveries.

**Service logs:**

```bash
docker compose -f docker-compose.app.yml logs -f github-app
```

**Health check:**

```bash
curl http://localhost:4001/health
```

## Diagnose

1. **Webhook secret mismatch?** — `GITHUB_APP_WEBHOOK_SECRET` in env must match what's set in GitHub App settings. Signature validation will reject every delivery.

2. **Service not reachable from GitHub?** — In local dev, check that smee.io relay is running (`npx smee-client …`). In prod, check that the webhook URL is publicly routable.

3. **App not installed on the repository?** — GitHub only sends events for installed repos. Check GitHub App → Installations.

4. **PR bot comment permission missing?** — The GitHub App needs `Pull requests: Read & Write`. Check App permissions in GitHub settings.

5. **Handler crash?** — If `apps/github-app` exits on a malformed event, GitHub retries with exponential backoff. The retry will succeed once the service is restarted.

6. **Rate limited by GitHub API?** — Log lines will include `X-RateLimit-Remaining: 0`. Wait for the reset window or use a different installation token.

## Mitigate

- Fix the webhook secret and restart `apps/github-app`.
- For local dev: restart the smee relay and the github-app service.
- Trigger a manual redelivery from GitHub App → Recent Deliveries → Redeliver.
- If session→PR linking is stale, the backfill job (P2-004) will re-link on next scheduled run.

## Escalate

If the GitHub App credentials (private key) are suspected compromised, rotate immediately via GitHub App settings → Private keys and update `GITHUB_APP_PRIVATE_KEY`. Escalate to the team lead. See [on-call.md](../on-call.md).
