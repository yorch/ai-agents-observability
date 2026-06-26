# Phase 6 — Hardening & scale-readiness (roadmap)

**Trigger to decompose**: raised from a review of known functional limitations
and architectural limits after the Phase 1–5 spine was code-complete. Most items
are *deliberately* deferred by the v1 scope (single-org, single-tenant,
single-instance, ~200 devs — `DESIGN_DOC.md` §2.2). This file records what was
done, what is deferred, and the trigger that should reopen each deferral.

**Status**: P6-001 through P6-004 are `done`; P6-005 and P6-006 are `deferred` and
superseded by Phase 8 (`P8-002`, `P8-003`, and `P8-004`). See [`INDEX.md`](./INDEX.md)
for task-level status.

## Goal recap

Close the gaps that affect the platform **as it exists today** — data integrity,
observability, and the team-views access model — while explicitly *not* building
multi-instance / multi-agent machinery the stated scope doesn't yet need.

## Done in this phase

- **Event-schema integrity.** `EventSchema` is now a `z.discriminatedUnion` on
  `event_type`: PreToolUse/PostToolUse require a `tool` block; lifecycle events
  keep it optional. The hook now emits the structured `tool` block (previously
  `tool_name` only reached `metadata`, leaving `events.tool_name` and the
  PostToolUse tool-call/error counts dead for real data). Protects the firehose
  the Phase 5 effectiveness signals consume.
- **Observability coverage.** Prometheus now scrapes `web` and `github-app` in
  addition to `ingest`; `github-app` moved off bespoke in-memory counters onto
  `prom-client`. (Grafana dashboards for the two new targets — see follow-ups.)
- **Non-blocking transcript pipeline.** `processTranscript` decompress/redact/
  recompress no longer runs synchronously on the `Bun.serve` event loop (async
  zlib on the threadpool + cooperative yields), so a large transcript can't
  starve `/v1/events`. The 512 MB decompression-bomb guard is preserved.
- **Explicit team-lead grants.** `requireTeamLead` was effectively ungated by
  GitHub. Added `/admin/team-roles` (org-admin only) to grant/revoke `lead`
  explicitly, audited via a new `role_grant` action — chosen over auto-mapping
  GitHub team-maintainer so dashboard visibility is granted, never inferred.

## Deferred — demand-gated (do NOT build speculatively)

- **Per-agent price tables.** At the time of the P6 review, `cost.ts` keyed cost on
  the model string, which was vendor-unique; the `_agentType` seam existed and the
  `unknown_model_events_total` metric now surfaces any unpriced ($0) model.
  **Superseded by:** P8-002, now `done`.
- **Hook adapter seam.** The transport (queue/flusher/shipper) was already
  agent-neutral; only `payload.ts`, the `~/.claude` paths, and the install
  commands were Claude-specific. **Superseded by:** P8-003/P8-004, now implemented
  and now `done`, with P8-007 adding the Codex adapter.

## Deferred — config / ops (no code change needed)

- **Ingest rate limiter is in-memory, per-instance.** Correct at v1 scope (~200
  devs ≈ ~40 req/s, one ingest instance). Documented inline in
  `apps/ingest/src/middleware/rate-limit.ts`. **Trigger:** running >1 ingest
  replica → move the window to a shared store (Redis).
- **Object-store durability.** MinIO single-node is a SPOF for transcripts
  (events keep flowing to TimescaleDB if it dies). The code already supports
  `S3_ENDPOINT_OVERRIDE` (`.env.example`). **Recommendation for prod:** point at
  real S3 / Backblaze B2; reserve HA MinIO for fully-on-prem deployments.

## Follow-ups opened by this phase

- Grafana dashboards for `web` and `github-app` (scrape configs landed; panels
  deferred — need a running Grafana to validate UIDs).
- Surface GitHub team-maintainer as a *suggested default* in `/admin/team-roles`
  (needs per-team membership API calls; the explicit grant remains the source of
  truth).

## Out of scope here (tracked elsewhere — operational sign-off)

These gate "production-ready" but are validation, not code: Phase 1 dogfood
sign-off (`P1-029`), real GitHub App registration (`P2-001`), GHES integration
test (`P2-010`).
