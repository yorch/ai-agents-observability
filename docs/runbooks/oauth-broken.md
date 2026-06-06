# Runbook: OAuth Login Broken

**Service**: `apps/web` GitHub OAuth flow  
**Impact**: No new sessions can authenticate; existing sessions with valid tokens are unaffected

---

## Symptoms
- `/login` returns error or redirect loop
- `GET /api/auth/callback` returns 500 or `bad_verification_code`
- Web logs show `Failed to exchange OAuth code`

## Diagnosis

```bash
# 1. Check web logs around the auth callback
docker compose logs --tail=200 web | grep -i oauth

# 2. Confirm env vars are set
docker compose exec web env | grep GITHUB_

# 3. Manually verify the callback URL matches GitHub app settings:
#    GitHub.com → Settings → Developer Settings → OAuth Apps → <your app>
#    Callback URL must match GITHUB_OAUTH_CALLBACK_URL in .env
```

### Common causes

| Cause | Signal | Fix |
|---|---|---|
| Callback URL mismatch | `bad_verification_code` or 302 to `/login?error=...` | Update GitHub OAuth app callback URL to match env |
| Expired client secret | `incorrect_client_credentials` | Rotate client secret in GitHub; update `GITHUB_OAUTH_CLIENT_SECRET` |
| Wrong client ID | `incorrect_client_credentials` | Verify `GITHUB_OAUTH_CLIENT_ID` matches GitHub app |
| JWT secret rotation | Users suddenly logged out | Old sessions invalid; if intentional, no action needed |
| Rate limit on GitHub OAuth | `rate limit exceeded` in logs | Wait 1h; or use a second OAuth app as failover |
| GITHUB_HOST misconfigured (GHES) | `ENOTFOUND github.example.com` | Set `GITHUB_HOST` to the correct GHES host URL |

## Mitigation

### Rotate client secret
1. Go to GitHub → OAuth App → "Generate a new client secret"
2. Update `GITHUB_OAUTH_CLIENT_SECRET` in `.env`
3. Restart the web service: `docker compose restart web`
4. Existing user sessions remain valid (JWT-signed, not OAuth-token-backed)

### Test the OAuth flow manually
```bash
# Construct an auth URL and test in browser:
# https://github.com/login/oauth/authorize?client_id=<GITHUB_OAUTH_CLIENT_ID>&scope=read:user,read:org
```

### Emergency bypass (dev only)
In extreme cases, seed a test user directly and issue a token via the DB:
```sql
-- DO NOT use in production
INSERT INTO users (github_login, github_id, display_name)
VALUES ('testuser', 999999, 'Test User')
ON CONFLICT DO NOTHING;
```

## Escalation
- P2: OAuth broken for > 30 minutes (blocks all new user access)
- P1: Existing user sessions also invalidated (e.g., JWT secret accidentally rotated)
