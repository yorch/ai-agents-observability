# Phase 9 — Alerting & Governance (roadmap)

**Trigger to decompose**: post-P6 gap assessment. Three structural gaps surfaced
once the P1–P6 spine was complete:

1. **Anomaly detection is render-time only.** `getAnomalies()` in
   `apps/web/src/lib/org-queries.ts` runs statistical checks (spend spike >2σ,
   error rate >10%) when the `/org/dashboard` page renders. Nothing fires when
   no one is looking. No alert history exists, no notification is ever delivered.
   The org dashboard is a passive surface when the project needs proactive signals.

2. **Governance is four static booleans.** `visibility_policies` gives each user
   four opt-in/opt-out controls, and `canViewIndividuals` is an org-admin standing
   privilege. There is no time-boxed access, no request/approve workflow, and no
   narrowly-scoped capability — org admins either have it all or have nothing.
   `DESIGN_DOC.md §8.4` describes the investigation path (org admin requests
   transcript access with justification, logged visibly to the user), but the
   **workflow UI and `access_grants` table do not exist**. The `delete_request`
   and `view_transcript` `AuditAction` entries are wired; the gated request/approve
   step that should precede them is not.

3. **The Audience-B research persona has no matching access model.**
   `DESIGN_DOC.md §3` describes the dev-tools/research persona as needing
   org-wide aggregates plus *sampled session investigation with audit logging* —
   narrower than org_admin (which grants standing config and transcript access),
   broader than viewer_aggregate (which is aggregate-only). No role or scoped
   grant maps to this persona today.

## Goal recap

Turn passive dashboards into proactive alerts. Make privileged access time-boxed,
requested, and narrowly scoped. Give the Audience-B research persona a capability
that matches its needs without granting standing full access.

**On real-time alerting:** `DESIGN_DOC.md §2.2` explicitly listed real-time
alerting and SIEM-style behavioral analytics as v1 non-goals — the right call
for an MVP. Phase 9 picks this up deliberately, scoped to aggregate-level signals
(spend, error rate, model anomalies) with a scheduled evaluation cadence rather
than a streaming pipeline. Individual session content is never delivered to
notification channels.

**On access control:** `DESIGN_DOC.md §8` (Access Control & Privacy) and its
trust posture are non-negotiable. Phase 9 extends the access model in the
direction §8.4 already pointed — every privileged transcript view must be either
the owner, or the result of a time-boxed, justified, approved grant, logged and
visible to the viewed user in `/me/audit`. Zero standing access beyond org_admin
role itself, and org_admin transcript reach becomes grant-gated rather than
implicit.

## Sketched tasks

- **P9-001 Alert rules engine (WS B, L)**
  Promote render-time anomaly detection into a scheduled evaluation job. New
  `alert_rules` + `alert_events` tables. Firing/resolving transitions recorded
  once (no spam). Reuses `getAnomalies()` thresholds.

- **P9-002 Alert notifications (WS E, M)**
  Deliver fired alerts to email / Slack / generic webhook. `/admin/alerts` config
  + history UI (org_admin only). Notifications carry aggregate data only — no
  individual session content or developer-identifying transcript data.

- **P9-003 Time-boxed access grants (WS C, L)**
  `access_grants` table + request/approve workflow for the §8.4 investigation
  path. Transcript/session access checks consult active non-expired grants.
  Every grant issue/use audited and surfaced to the viewed user in `/me/audit`.

- **P9-004 Per-team retention overrides (WS B, M)**
  Teams can carry a `retention_days` override (shorter or longer, bounded by
  org max). `sweep-retention` honors it; falls back to global default when
  absent.

- **P9-005 Research role / investigator capability (WS C, M)**
  A grant-scoped investigator capability for Audience B: can view sampled
  individual sessions only through an active, expiring, audited grant. Never
  standing access. Honors `visibility_policies`.

- **P9-006 Governance + alerting invariant tests (WS F, M)**
  Property/integration tests proving: expired/revoked grants deny access; alerts
  never include individual-identifying content; alert firing is idempotent;
  retention overrides are bounded.

## Trust guardrails

Alerting must not leak individual data into channels. Fired alerts carry only
aggregate signals (team-level spend, org-level error rate); they never embed
session IDs, user names, or transcript excerpts. New roles and grant types must
be auditable, expiring, and visible to the individuals they affect — the trust
posture from `DESIGN_DOC.md §8` and §11 (trust as the gating factor for
adoption) is the hard constraint, not a preference.

## Exit criteria

- [ ] A spend spike fires a notification within one evaluation cycle after the
      condition is detected; the notification contains no individual-identifying
      data.
- [ ] Every privileged transcript view is either the session owner, or a
      time-boxed approved grant — no implicit standing org-admin transcript reach.
- [ ] Every grant issue, approval, and use is logged and visible to the viewed
      user at `/me/audit`.
- [ ] A research-role user can investigate sampled sessions only within an
      active, expiring, audited grant; after expiry, access reverts to
      aggregate-only.
- [ ] Zero standing access beyond `org_admin` role itself (and org_admin
      transcript access is grant-gated).
- [ ] Governance invariant tests pass in CI (`bun run test`).
