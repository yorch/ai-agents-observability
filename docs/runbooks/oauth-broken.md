# Runbook: OAuth Broken

## Symptoms

- Users unable to log in to the web UI — redirect loop or "Unauthorized" on `/api/auth/callback`.
- Hook CLI device-code flow failing — `login` command errors or hangs.
- `apps/web` logs: `auth.callback.error` or `session.decode.error`.

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

```
Grafana: http://localhost:3001 (see on-call.md)
```

There are no dedicated OAuth metrics yet (P4-009 tracks adding them). For now rely on logs.

**Web logs:**

```bash
docker compose -f docker-compose.app.yml logs -f web
```

**Ingest auth logs:**

```bash
bun run docker:app:logs | grep 'auth\|token\|identity'
```

## Diagnose

1. **GitHub App credentials revoked or rotated?** — Check `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY` are still valid. Regenerate via GitHub App settings if needed.

2. **JWT secret missing or rotated?** — `JWT_SECRET` (or `SESSION_SECRET`) must match between web and ingest. A mismatch causes every auth token to fail verification.

3. **Callback URL mismatch?** — GitHub OAuth requires the callback URL in the App settings to match `NEXT_PUBLIC_URL + /api/auth/callback`. Update it when the deployment URL changes.

4. **Clock skew?** — JWT `exp` validation fails if the server clock is >5 min off. Check `date` on the host.

5. **Device-code flow (hook CLI)?** — The hook uses `INGEST_URL` and `GITHUB_APP_CLIENT_ID`. Verify both are correct in the hook's config (`~/.config/claude-telemetry/config.json`).

## Mitigate

- Rotate the GitHub App credentials and update env vars, then restart `apps/web` and `apps/ingest`.
- If JWT secret was rotated: existing sessions are invalidated — users must re-login (expected behavior).
- Temporary workaround: if the web UI is inaccessible, direct-API access via curl with a valid token still works.

## Escalate

If credentials are suspected compromised (not just misconfigured), escalate to the security team immediately. See [on-call.md](../on-call.md).
