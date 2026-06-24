# Phase 6 — Hardening & scale-readiness (roadmap)

**Trigger to decompose**: raised from a review of known functional limitations
and architectural limits after the Phase 1–5 spine was code-complete. Most items
are *deliberately* deferred by the v1 scope (single-org, single-tenant,
single-instance, ~200 devs — `DESIGN_DOC.md` §2.2). This file records what was
done, what is deferred, and the trigger that should reopen each deferral.

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

- **Per-agent price tables.** `cost.ts` keys cost on the model string, which is
  vendor-unique today; the `_agentType` seam exists and the
  `unknown_model_events_total` metric now surfaces any unpriced ($0) model.
  **Trigger:** a second agent ships whose model names collide with, or price
  differently from, Anthropic's. Until then this is pure carrying cost.
- **Hook adapter seam.** The transport (queue/flusher/shipper) is already
  agent-neutral; only `payload.ts`, the `~/.claude` paths, and the install
  commands are Claude-specific. **Trigger:** a concrete second-agent
  (Cursor/Aider/…) requirement — extract the seam *from two real examples* to
  avoid the wrong abstraction. Tracks `DESIGN_DOC.md` §2.4 / P5-006.

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
