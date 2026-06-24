---
id: P9-002
title: Alert notification delivery + admin UI
phase: 9
workstream: E
status: review
owner: claude
depends_on: [P9-001]
blocks: [P9-006]
estimate: M
---

## Goal

Deliver fired alerts to configured channels (email, Slack, generic webhook) and
add an `/admin/alerts` page for rule config, channel config, and alert history.

## Context

- `P9-001` produces `alert_events` rows when rules fire or resolve. This task
  consumes them — the evaluation engine and the delivery engine are deliberately
  separate so each can be tested independently.
- Channel config (webhook URL, Slack token, email address) must be stored as
  org-level settings, not environment variables, so they're editable at runtime
  without a redeploy.
- **Trust guardrail (non-negotiable):** notification payloads carry aggregate
  signals only. No session IDs, user names, login handles, or transcript excerpts
  may appear in any channel — not in the body, not in the subject line, not in
  metadata fields. Violations here are political and compliance failures.
- Delivery failures must not crash the evaluation job (P9-001). Retries and
  failure logging belong in the notification layer.

## Acceptance criteria

- [ ] A fired `alert_events` row triggers delivery to every configured, enabled
      channel within one evaluation cycle.
- [ ] Supported channel types on day one: `email` (via SMTP), `slack_webhook`
      (Slack incoming webhook URL), `webhook` (generic HTTP POST).
- [ ] Notification payload contains: rule name, severity, fired_at, a human-readable
      description of the aggregate condition (e.g. "Org spend spiked 3.2σ above
      14-day baseline"), and a link to `/org/dashboard`. It does NOT contain
      session IDs, user handles, or any individual-attributable data.
- [ ] `/admin/alerts` page (org_admin only) allows: enabling/disabling individual
      rules; editing rule params (threshold overrides); adding/editing/removing
      channel configs; viewing alert history (fired_at, resolved_at, severity,
      rule name).
- [ ] Alert history in the UI is aggregate-only — the detail view shows the same
      fields as the notification payload, not raw `details JSONB` that might
      contain individual-identifying context.
- [ ] Delivery failures (network error, bad webhook URL, SMTP error) are logged
      to a `alert_delivery_log` table (channel_type, attempted_at, error TEXT
      nullable, success BOOLEAN) and do not block the scheduler job.
- [ ] Failed deliveries are retried up to 3 times with exponential backoff within
      the same job run; persistent failures are surfaced in the admin UI.
- [ ] TypeScript and Biome clean.

## Implementation notes

- Channel implementations live under `apps/ingest/src/lib/notify/` as separate
  modules (`email.ts`, `slack.ts`, `webhook.ts`) with a shared `Channel` interface:
  `send(payload: AlertPayload): Promise<void>`.
- Channel configs can live in a new `alert_channel_config` table
  (id, channel_type, config JSONB encrypted or plaintext, enabled); or as a
  JSONB column on a new `org_settings` table if one is being introduced anyway.
  Either is fine — choose whichever requires fewer new tables.
- The `/admin/alerts` page is a Server Component with a Server Action for edits.
  Reuse the existing admin layout and auth guard pattern from other `/admin/*`
  pages.
- Rule param edits (e.g. overriding the 2σ threshold) update the `alert_rules`
  row; the evaluation job picks them up on the next cycle.

## Files touched

- `packages/db/prisma/schema.prisma` (AlertChannelConfig, AlertDeliveryLog models)
- `packages/db/sql/migrations/` (new migration)
- `apps/ingest/src/lib/notify/` (new directory: `channel.ts`, `email.ts`,
  `slack.ts`, `webhook.ts`)
- `apps/ingest/src/jobs/evaluate-alerts.ts` (wire notification dispatch)
- `apps/web/src/app/admin/alerts/page.tsx` (new)
- `apps/web/src/app/admin/alerts/actions.ts` (new Server Actions)

## Out of scope

- PagerDuty / OpsGenie / JIRA integrations.
- Per-user alert subscriptions (org-level channels only).
- Alert muting or suppression windows.
- SMS delivery.

## Verification

```bash
bun run typecheck
bun run check
# Integration: configure a webhook channel pointing to a local listener,
# seed an alert_events row with resolved_at=null, trigger the evaluate-alerts
# job, verify the listener receives a POST with no user-identifying fields.
bun --filter '@ai-agents-observability/web' test
```

> **Verification status (review):** `alert-notify.test.ts` (5 cases — payload shape, **trust
> guardrail: no session/user/login/leak in serialized payload**, disabled-channel skip,
> failure-logs-without-throwing + retry) **passes locally** + biome clean. Delivery layer
> (`notify/`: payload, channel dispatcher with 3x backoff + delivery log, webhook/slack POST
> channels, email seam) is separate from evaluation (P9-001) and wired in on FIRED transitions
> only. `alert_channel_config` + `alert_delivery_log` tables + migration; `/admin/alerts` (rules
> toggle, channel CRUD, aggregate-only history, recent failures).
>
> **Scope notes:** (1) email ships as a documented seam that throws "SMTP not configured" (no SMTP
> dep in the pinned catalog — wiring it is a separate reviewed change); webhook + slack are real
> POSTs. (2) Channel configs live in `alert_channel_config` (runtime-editable, not env). (3) Rule
> param/threshold editing beyond enable/disable is a follow-up — thresholds are the shared
> constants from P9-001. `typecheck` + DB tests run in CI (Prisma egress-blocked locally).
