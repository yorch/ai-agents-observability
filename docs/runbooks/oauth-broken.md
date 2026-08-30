# Runbook: OAuth Broken

## Symptoms

- Users are returned to `/login` with a GitHub sign-in error and support reference.
- Hook CLI device-code flow failing — `login` command errors or hangs.
- `apps/web` logs: `auth.callback.state_mismatch`, `auth.callback.oauth_exchange_failed`,
  `auth.callback.unexpected_error`, or `session.decode.error`.

## Observe

**Metrics:** Grafana — http://localhost:3001 (see [on-call.md](../on-call.md))

```
Grafana: http://localhost:3001 (see on-call.md)
```

There are no dedicated OAuth metrics yet. For now rely on web and ingest logs.

**Web logs:**

```bash
docker compose -f docker-compose.app.yml logs -f web
```

Search these logs for the support reference shown on the login page. It is the callback
request ID and correlates directly with the server-side error without exposing OAuth
codes, state values, or exception details to the user.

**Ingest auth logs:**

```bash
bun run docker:app:logs | grep 'auth\|token\|identity'
```

## Diagnose

1. **GitHub OAuth credentials revoked or rotated?** — Check `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are still valid. Regenerate via the OAuth App settings if needed.

2. **JWT keypair missing or rotated?** — `JWT_ED25519_PRIVATE_KEY` and `JWT_ED25519_PUBLIC_KEY` must be present for login and token verification. Generate the production pair with `just prod-keys`; if the keypair changes, existing sessions and hook tokens are invalidated.

3. **Callback URL mismatch?** — Set `APP_BASE_URL` to the browser-facing HTTPS origin (for example, `https://agentometry.brnby.com`) and configure the GitHub OAuth App callback as that origin plus `/api/auth/callback`. Do not use a Docker bind address such as `0.0.0.0:3000`. Update both when the deployment URL changes.

4. **Clock skew?** — JWT `exp` validation fails if the server clock is >5 min off. Check `date` on the host.

5. **Device-code flow (hook CLI)?** — The hook login command talks to the web app, defaulting to `http://localhost:3000`. Set `AIOT_API` to the correct web URL and check `~/.aiot/identity.json` after login.

## Mitigate

- Rotate the GitHub OAuth credentials and update env vars, then restart `apps/web`.
- If the JWT keypair was rotated: existing sessions and hook tokens are invalidated — users must re-login (expected behavior).
- Temporary workaround: if the web UI is inaccessible, direct-API access via curl with a valid token still works.

## Escalate

If credentials are suspected compromised (not just misconfigured), escalate to the security team immediately. See [on-call.md](../on-call.md).
