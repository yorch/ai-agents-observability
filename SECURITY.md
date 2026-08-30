# Security Policy

## Reporting vulnerabilities

We take security vulnerabilities seriously. If you believe you have found a
security issue, please report it responsibly:

- **Email:** security@example.com (replace with your deployment's contact)
- **Do not** open a public GitHub issue for security vulnerabilities.
- Please include a description of the issue, steps to reproduce, and any relevant
  logs or proof-of-concept code.
- We will acknowledge receipt within 48 hours and aim to provide an initial
  assessment within 5 business days.

## Authentication

- **JWT signing:** Access and refresh tokens are signed with Ed25519 keys
  (`EdDSA` algorithm). The signing key is loaded from environment-provided PEM
  (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`) — there are no hardcoded keys.
- **Access tokens:** 8-hour TTL, carrying `kind: "ACCESS"` and the user's `sub`.
- **Refresh tokens:** 90-day rotation. Opaque tokens are SHA-256-hashed before
  storage so the database never holds a usable credential.
- **Hook tokens:** 365-day TTL for the developer-installed CLI. Opaque and
  SHA-256-hashed in the same way as refresh tokens.
- **Token-kind separation:** JWT `kind` claims and database token records
  distinguish `ACCESS`, `REFRESH`, and `HOOK`. A hook token cannot be used as a
  dashboard access token, and a refresh token cannot be used as a hook token —
  each verification path checks the expected kind and rejects mismatches.
- **Password hashing:** scrypt with timing-safe comparison. Parameters are
  tuned for a server-side cost of ~100 ms. A dummy hash is verified on every
  login attempt (even for non-existent emails) so response time does not reveal
  whether an account exists.
- **Login rate limiting:** In-process rate limiting on both password-based
  login endpoints (dashboard `/api/auth/password` and CLI `/api/auth/token`) —
  5 failed attempts per (IP, email) pair per 15-minute window before a 429 is
  returned. Successful logins reset the counter. See "Known limitations" for
  the multi-instance caveat.

## Authorization

- **Role-based access:** Three org-level roles control dashboard access:
  `ORG_ADMIN` (full org scope), `VIEWER_AGGREGATE` (aggregate dashboards, no
  individual transcript access without a grant), and `INVESTIGATOR` (aggregate
  access plus the ability to request time-boxed grants). Team-level access is
  gated by the `team_lead` role via `requireTeamAccess()`.
- **Per-user visibility policies:** Transcript sharing with the org and team is
  **off by default**. Each user controls their own `VisibilityPolicy` — an admin
  cannot read a not-shared transcript without a justification or an approved
  grant.
- **Time-boxed access grants:** Cross-user transcript access requires an
  approved, non-expired, non-revoked `AccessGrant` with a scope that covers the
  target session or user. Every grant requires a free-text **justification**
  (minimum 10 characters) recorded on the grant and the audit row.
- **Audit logging on every cross-user view:** Every privileged cross-user
  transcript or session view writes an `AuditLog` row with the actor, target,
  justification, IP, and user agent. Transcript proxy endpoints (org and team)
  are fail-closed — see "Audit logging" below.

## Data redaction

- **Double redaction:** Transcripts are redacted once client-side in the hook
  binary and again server-side in the ingest pipeline before any S3/MinIO write.
  The server does not trust that the client ran redaction.
- **9 regex rule classes:** AWS access keys, AWS secret keys, GitHub tokens,
  JWTs, Slack tokens, environment-secret patterns, private keys, git remote URL
  credentials, and email addresses. Rules run in a fixed order so structural
  secret rules fire before the git-remote-url rule (which would otherwise
  clobber their markers).
- **`events.metadata` protection:** Content-bearing metadata keys are stripped
  server-side via `stripContentBearingKeys()` before the JSONB row is written,
  because redaction scrubs secrets, not prose.
- **`git_remote_url` credentials stripped before persisting:** HTTP(S) URLs
  with embedded credentials (`https://token@github.com/...`) are run through
  the redaction package before being stored in `sessions.git_remote_url`. The
  userinfo is replaced with `[REDACTED:git-remote-url]`; scheme, host, and path
  are preserved so the remote stays identifiable. SSH-format remotes
  (`git@host:repo`) do not carry inline credentials and are stored as-is.

## Audit logging

- Every privileged cross-user transcript/session view is audit-logged with the
  actor user ID, target user ID, target session ID, justification (when
  applicable), client IP, and user agent.
- **Fail-closed on transcript proxy endpoints:** Both cross-user transcript
  endpoints (`/api/org/transcripts/[id]` and
  `/api/team/[slug]/member/[login]/transcripts/[id]`) await the audit write and
  return a **503** if the audit row cannot be persisted. Transcript content is
  never streamed without a durable audit trail.
- Lower-stakes audit call sites (session detail pages, admin actions, exports)
  remain fire-and-forget — a failed audit write there does not block the action.

## Deployment hardening (operator responsibilities)

The application code provides the controls above; the following are operator
responsibilities at the infrastructure layer:

- **TLS termination:** Terminate TLS at the reverse proxy (e.g. Traefik, nginx).
  The application listens on plain HTTP inside the container network.
- **Encryption at rest:** Configure Postgres and MinIO/S3 encryption at rest
  according to your infrastructure provider. The application does not manage
  disk-level encryption.
- **Secret management:** No secrets are hardcoded in the codebase. All secrets
  (JWT signing keys, database credentials, S3 credentials, OAuth client
  secrets, API keys) must be provided via explicit environment variables. Use a
  secrets manager (e.g. Vault, AWS Secrets Manager) in production.
- **Network policies:** Restrict ingress to the web, ingest, and GitHub-app
  ports. The ingest endpoint (`:4000`) should only be reachable by developer
  machines or CI runners, not the public internet.
- **Image signing:** Sign container images in your CI pipeline and verify
  signatures before deployment.

## Security headers

Security headers (HSTS, Content-Security-Policy, X-Frame-Options,
X-Content-Type-Options, Referrer-Policy) should be set at the **reverse proxy
layer** (Traefik, nginx, or a CDN). The application's `next.config.ts` does not
set these headers — this is a deliberate separation so the operator can tailor
CSP to their deployment (allowed script sources, analytics, etc.).

## Known limitations

- **Regex-based redaction, not semantic:** The redaction package uses regex
  pattern matching, not ML or semantic analysis. A credential formatted in a way
  no rule matches will pass through. The double-redaction approach (client +
  server) mitigates but does not eliminate this.
- **In-process rate limiting:** The login and device-poll rate limiters are
  in-memory, per-instance Maps. In a multi-instance deployment, each instance
  has its own counter, so the effective limit is multiplied by the instance
  count. A shared store (e.g. Redis) is needed for true distributed rate
  limiting.
- **No SAML/SSO yet:** Authentication supports GitHub OAuth (web dashboard) and
  a device-code flow (hook CLI). SAML/SSO integration is not yet implemented.
- **Single-tenant only:** The system is designed for a single organization per
  deployment. Multi-tenant isolation is not implemented.
