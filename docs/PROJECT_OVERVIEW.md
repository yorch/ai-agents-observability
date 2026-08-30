# Project Overview — ai-agents-observability

> A synthesized reference for the whole system: purpose, personas, architecture,
> implemented capabilities, the data model, non-goals, and the seams where new
> requirements will land. Use this when drafting new requirements, plans, specs,
> and goals.
>
> Companion docs: [`DESIGN_DOC.md`](../DESIGN_DOC.md) (canonical scope),
> [`PLAN.md`](../PLAN.md) (phasing/decisions, Phases 1–9),
> [`OPPORTUNITIES.md`](../OPPORTUNITIES.md) (assessment of unrealized value —
> the primary input for "what to build next"), [`AGENTS.md`](../AGENTS.md)
> (agent guidelines), and [`tasks/`](../tasks/) (the P1–P13 task breakdown).
>
> **Currency:** reflects `main` as of the P6–P9 work (HITL observability,
> alerting & governance, multi-agent adapters, insight surfaces), plus P11
> (correlation & Jira), P12 (agent adapter expansion — seven agents) and P13
> (scoring & evaluation — the versioned `scores` substrate, `run_kind`,
> deterministic trajectory scorers, the opt-in judge), and the post-revamp UI/UX
> review ([`docs/design/ui-ux-review-2026-08.md`](design/ui-ux-review-2026-08.md) →
> the `ActionResult` contract, `CardEmpty`/`EmptyState`, the `fmt.ts` monopoly,
> `useFocusTrap`, `FilterChips`, and the nav-model-derived command palette).
> Phase 10 (model cost optimization) is in a contradictory state — `tasks/INDEX.md`
> marks it `done`, every `P10-*.md` file reads `ready`, and no `model_policy` table
> exists. If you are reading this much later, re-verify against
> `tasks/INDEX.md` — that file, not this one, is the source of truth for status.

---

## 1. What it is

A **self-hosted, single-tenant observability platform for AI coding agents**
(Claude Code first, now genuinely multi-agent). It ingests per-event telemetry
from developer machines, archives redacted session transcripts, correlates work
to GitHub PRs and teams, and exposes role-scoped dashboards.

The scope is deliberately narrow:

> It is **not** model observability (inference latency, prompt eval, drift) and
> it is **not** generic AI observability (RAG quality, embeddings, fine-tuning).
> The narrower target is **how humans use AI coding agents to do real
> engineering work** — sessions, tools, skills, MCP servers, PR outcomes.

- **Reference deployment:** ~200 developers at a single org.
- **License:** FSL-1.1-MIT (usable for any non-competing purpose, converts to MIT
  two years after each release) — consistent with a future open-source spin-off.
- **The name is plural on purpose:** the schema was multi-agent from day one, and
  as of Phase 12 that bet is realized — seven adapters ship (`claude-code`,
  `opencode`, `codex`, `gemini-cli`, `copilot`, `pi`, `omp`)
  alongside Claude Code.

---

## 2. Personas — the spine of the product

| Audience | Persona | Core question | Access level | Priority |
|---|---|---|---|---|
| **C** | Individual developer ("My Agents") | "How am I using AI? What's it cost? What am I sharing?" | Full access to **own** data + privacy controls | **Primary — the trust anchor** |
| **B** | Dev-tools / research team | "Is it working? Where's the friction? What predicts success?" | Org aggregates + **grant-scoped, audited** session investigation (new `INVESTIGATOR` role — no standing individual access) | **Primary** |
| **A** | Leadership / finance | "What is this costing, and where? What's the ROI?" | **Aggregates only** (`viewer_aggregate`) — never individual sessions | Secondary |

The political thesis that drives the entire design:

> If developers find their own page genuinely useful, adoption follows. If the
> first thing they see is a manager's dashboard with their name on it, the
> project fails politically.

This is why **transcript-sharing is OFF by default**, every privileged cross-user
read is audit-logged and visible to the subject, a user "can never be opted *up*
by an admin," and — as of Phase 9 — even org-admin/investigator access to an
individual's sessions is **time-boxed, justified, approved, and expiring** rather
than standing.

---

## 3. Architecture at a glance

**Three planes split by access pattern:**

- **Ingest** (`apps/ingest`, Hono/Bun, :4000) — stateless event intake +
  transcript storage + scheduled jobs (incl. the alert-evaluation engine).
- **Storage** — split three ways:
  - **TimescaleDB** `events` hypertable (the firehose) + 3 continuous aggregates
  - **Postgres** dimensional tables (sessions, users, teams, PRs, governance)
  - **S3 / MinIO** for transcript blobs
- **Query / UI** (`apps/web`, Next.js 16, :3000) — read-only dashboards +
  governance workflows (grant request/approve, alert admin).

**Plus two edge components:**

- `apps/github-app` (Hono/Bun, :4001) — GitHub webhook receiver, PR enrichment.
- `apps/hook` (Bun single-binary CLI) — runs on dev machines, captures agent
  events + transcripts, ships them to ingest. Now built on a pluggable **adapter
  seam** — seven agents in three shapes: stdin hooks over a shared factory
  (Claude Code, Codex, Gemini CLI, Copilot CLI), in-process extensions (Pi, omp),
  and opencode's own plugin event bus.

**Shared packages:** `auth` (no NextAuth), `db` (Prisma 7 + raw SQL migrations),
`github` (Octokit wrapper), `redaction` (secret/PII scrub), `schemas` (zod wire
contract). **Infra:** `migrations-runner` (one-shot container; the canonical
migration path).

### Defining data decisions

- **Hash-and-blob:** only hashes + byte sizes of tool I/O hit the SQL events
  table; raw content lives *only* in the post-redaction transcript blob. Storage
  savings + compliance posture; trade-off is you can't SQL-query specific inputs.
- **Client-computed cost** from **versioned, per-agent price tables** served by
  ingest (`price-table.<agent>.v1.json`) → price changes propagate without
  redeploying hooks. Ingest recomputes server-side; client cost is not trusted.
  A `reconcile-cost` job compares against vendor billing sources — an
  `AnthropicBillingSource` (Admin Cost Report API, `ANTHROPIC_ADMIN_KEY`) and a
  `GitHubBillingSource` (AI-credit usage report, `GITHUB_BILLING_TOKEN` +
  `GITHUB_BILLING_SCOPE`), each wired only when its own credential is set, and a
  null source when neither is. Vendor bills are org-wide, so drift is an
  org-level claim; and drift against an agent that captured no tokens is
  recorded but never counted as a pricing breach. The job is gated off by default.
- **Every computed signal is a versioned score** (Phase 13). Scorer identity and
  version live in one registry (`packages/schemas/src/scores.ts`) and every value
  lands in `scores` with the scorer that produced it — so re-scoring history after a
  scorer change is a version bump plus one trigger, not a bespoke backfill job.
- **`run_kind` separates humans from machines.** Sessions and events carry
  `INTERACTIVE` | `CI` | `EVAL`. Non-interactive runs are stored and trendable but
  never enter a number presented as developer behaviour — the filter is baked into
  the three continuous aggregates and enforced across the query layer by
  source-scanning lints in both `apps/web` and `apps/ingest`.
- **Capture-more-now / surface-later:** cheap-to-capture, expensive-to-backfill
  signals are captured day one; Phase 7 was largely about *surfacing* what Phase 5
  already computed.
- **Multi-agent by construction:** `agent_type` on every event/session; the
  `<agent>:<tool>` naming convention prevents tool-name collisions across agents.

---

## 4. The end-to-end data flow

```
Agent hook fires (any of the seven agents, via the adapter seam)
  → hook CLI (hook-entry, <10ms) writes event to local SQLite queue, exits
     · SessionStart now captures real git context (branch/commit/remote/dirty)
     · permission mode canonicalized (normal→bypass autonomy ranks); Notification
       events classified (permission/idle/elicitation/auth/other)
  → flusher (out-of-process) batches every 5s / 50 events → POST /v1/events
  → ingest: validate, recompute cost (per-agent table), bulk-insert to events
            hypertable, atomic additive session upsert, best-effort session↔PR link
  → on Stop: shipper redacts + zstd + chunk-uploads transcript
            → POST /v1/transcripts/:id → ingest re-redacts → S3 key on session row

GitHub PR event → github-app webhook: upsert PR (state, is_draft, jira_key,
  revert links), backfill session↔PR links, compute rollup, count CI check
  failures, post opt-in bot comment (.claude-telemetry.yml driven).

Scheduled jobs (ingest, advisory-locked): team sync, abandoned sweep,
  compute-effectiveness (friction + shape + response-latency), transcript FTS
  index, evaluate-alerts (→ Slack/webhook/email), retention sweep (per-team
  override), GDPR deletion runner, trajectory + subject scorers, the opt-in judge.
  (Cost reconciliation is gated off by default, and falls back to a null billing
  source unless ANTHROPIC_ADMIN_KEY or GITHUB_BILLING_TOKEN + GITHUB_BILLING_SCOPE
  are set. embed-transcripts is a gated prototype,
  not scheduled.)

Web reads: dev sees /me + /me/insights; lead sees /team/[slug] (audit-logged);
  leadership sees /org/* aggregates; investigators act only under a live grant.
```

---

## 5. Implemented capabilities

The system is **built well past its original design** — per `tasks/INDEX.md`,
Phases 1–9, 11 and 12 are code-complete and Phase 13 is in review; open items are
operational sign-off / manual
integration (see §8).

### Hook CLI (`apps/hook`)
Adapter-based capture (seven agents; `--agent <name>` selects one). Full command surface:
`login` (GitHub device-code **+ password fallback**), `install`/`uninstall`
(launchd/systemd), `status`, `pause`/`resume`, `purge-local`, `import`
(historical backfill from `~/.claude/projects`), the internal `hook <kind>`
entrypoint, `flusher`, `shipper`. Offline-durable SQLite queue (WAL), a p99
cold-start budget of **<15 ms on developer hardware**, git-at-session-start capture,
throttled transcript upload. The budget is *measured* in CI (`.github/workflows/perf.yml`,
uploaded as an artifact for trend tracking) but **not enforced** — it runs
`continue-on-error`, because a shared `ubuntu-latest` runner measures Bun
single-file-binary cold start at ~60–80 ms regardless of the code. Re-tighten it if the
job ever moves to dedicated perf hardware.
*(A directory-shaped transcript target — opencode's — is collated into one JSONL
by the shipper before upload, out of the hot path.)*

### Ingest (`apps/ingest`)
- `POST /v1/events` (idempotent batch), `POST /v1/transcripts/:id` (chunked,
  re-redacted), `GET /v1/price-table?agent=` (per-agent, ETag), `/health`,
  `/readyz`, `/metrics`, `POST /admin/jobs/:name/run`.
- **19 dispatchable jobs in three tiers.** Seven have an operator-editable cadence in
  `job_config` (`sweep-retention`, `index-transcripts`, `compute-effectiveness`,
  `compute-trajectory-scores`, `compute-subject-scores`, `evaluate-alerts`,
  `judge-sessions`); eight more run on fixed timers or are drainable over HTTP
  (`sync-teams`, `sync-jira`, `sweep-abandoned`, `sweep-scratch`, `run-deletions`,
  `backfill-redaction`, and the `reprice-events` / `reprice-events-apply` pair, which
  is one job behind a two-name safety interlock — the bare name reports, `-apply`
  writes); four are one-shot and reachable only from in-process operator
  code, never over HTTP (`compute-effectiveness-backfill`, `rescore-effectiveness`,
  `rescore-trajectory`, `reconcile-cost`). Notably the **alert-evaluation engine**
  (`evaluate-alerts` → `alert-transition` → notify channels) and
  `compute-effectiveness` (friction score, shape label, human-response-latency).

### GitHub App (`apps/github-app`)
HMAC-verified webhook intake (202-before-processing + idempotency). Handles four
event types: `pull_request` (upsert with `is_draft`, `jira_key`, revert links; rollup
on merge; opt-in bot comment), `check_run` (CI failure counts), `pull_request_review`
(review decisions) and `push` (commit↔session correlation on the default branch).
GHES-capable.

### Web (`apps/web`, Next.js 16) — new capability areas in **bold**
- **My Agents (`/me/*`):** overview, sessions (list + detail with
  **owner-initiated session sharing**), **redesigned transcript viewer**
  (parse layer + conversation/raw modes, streaming, virtualized),
  **`/me/insights`** (friction-source decomposition + **coaching
  recommendations**), PRs, **`/me/search`** (self-service transcript FTS),
  **`/me/grants`**, settings (profile / privacy / audit).
- **Team (`/team/[slug]/*`):** overview, roster, sessions, PRs, member drill-in
  (audit-logged), adoption, tools, **MCP**, **agents**, **skills** (+ drill-down).
- **Org (`/org/*`):** dashboard (cost, trends, anomalies, friction, **spend
  forecast**, **cohort friction divergence**), adoption, delivery, benchmarks,
  teams, faceted search, tools, **MCP portfolio**, **skills analytics**,
  **agents comparison**, **models** (**routing recommendations** + cache
  opportunities), **governance** (HITL oversight, provenance), **ROI**,
  **security** (data-flow exposure, MCP egress, secret-exposure by redaction
  class, audit summary), **knowledge** (aggregate transcript topic clustering).
- **Admin (`/admin/*`):** jobs, org-roles, **team-roles**, **price-tables**,
  **retention**, **access-grants** (request/approve), **adapters**, **alerts**.
- **Time-range pickers (7/30/90d)** across all org/team analytics.
- **Auth:** GitHub OAuth + password + device-code (hook login).

### Cross-cutting new capability themes (P6–P9)
- **HITL / autonomy observability (P#76):** per-session permission-mode mix,
  denial rate, human-response-latency to blocking prompts, a **rubber-stamp /
  over-trust detector**, `SessionFeedback` (👍/👎 ground truth), and a
  compliance-framed governance page (EU AI Act Art. 14 / NIST AI RMF / SOC 2).
- **Alerting & governance (P9):** six scheduled alert rules — spend spike, error
  rate, unknown-model surge, autonomy surge, budget threshold and routing waste;
  all six are evaluated, the last two seeded disabled pending a threshold — with
  Slack/webhook/**SMTP email** delivery + acknowledge/silence; **time-boxed
  access grants**; per-team retention; the **`INVESTIGATOR`** research role.
- **Multi-agent & cost (P8):** `<agent>:<tool>` disambiguation, per-agent price
  tables, hook adapter seam validated against two real agents, de-Claude-ified
  copy, cost-reconciliation scaffold.
- **Insight surfaces (P7):** friction/shape rendered across `/me`, team, org;
  self-service transcript search; enriched facets. Semantic (pgvector) search was
  evaluated and **declined** (P7-007) — keyword FTS stays until a proven recall
  gap + a self-hosted embedding path exist.

---

## 6. The data model

- **`events`** (Timescale hypertable, 1-day chunks, compressed after 7 days) — the
  firehose. Tool / MCP / skill / slash / model / token / cost / mode fields +
  `notification_kind` + JSONB metadata. Only hashes + byte sizes of tool I/O.
- **`sessions`** — central fact table: lifecycle, **now-populated git context**,
  additive aggregates, transcript pointer, `friction_score`, `shape_label`, and
  **HITL fields**: `mode`, `notification_count`, `total_response_ms` /
  `response_sample_count`.
- **`session_feedback`** — per-session 👍/👎 + note, plus a `rubric_version` (P13-005).
  The human ground truth that calibrates friction/autonomy signals. The rubric's two
  answers are **not** columns here — they are `HUMAN` rows in `scores`, so calibration
  reads one table.
- **`scores`** (P13-001) — the scoring substrate. One row per
  `(subject_type, subject_id, scorer_name, scorer_version, period_start)`: a value or a label, its
  source (`HEURISTIC` | `DETERMINISTIC` | `HUMAN` | `JUDGE` | `OUTCOME`), optional
  `cost_usd` for judge spend, and a `rationale_ref` pointer — never inline content.
  Subjects are heterogeneous (session, PR, skill, MCP server), so there is no FK and
  session-scoped rows are deleted explicitly by `run-deletions`.
- **`projections`** (P13-006) — a recorded prediction (range, unit, baseline, period,
  active price-table and scorer versions, plus outcome-guard baselines) so a claimed
  saving can be graded against what actually happened, and a "win" alongside rising
  friction is flagged rather than celebrated.
- **`run_kind`** on both `sessions` and `events` — `INTERACTIVE` | `CI` | `EVAL`,
  defaulting to `INTERACTIVE`, with a partial index on the non-default values.
- **PR side:** `pull_requests` (`is_draft`, `jira_key`, revert links, CI/review
  decision), `session_pr_links`, `pr_rollups` (cost-per-LOC, `check_failures_count`).
- **Governance:** `visibility_policies` (4 flags), `audit_log` (with new
  `GRANT_*` / `ALERT_*` actions), `access_grants` (+ `GrantScope`),
  `deletion_requests`, `auth_tokens`; `users.org_role` now includes `INVESTIGATOR`;
  `teams.retention_days` override.
- **Alerting:** `alert_rules`, `alert_events` (with `acknowledged_*`),
  `alert_channel_configs`, `alert_delivery_log`.
- **Org:** `teams` (self-referential), `team_members`, `users`, `repos`.
- **Ops:** `job_config`, `job_runs`, `webhook_deliveries`, `transcript_index`
  (FTS GIN), 3 continuous-aggregate views. *(A gated pgvector
  `transcript_embeddings` prototype lives under `sql/prototypes/`, not applied.)*

### Telemetry & schemas (`packages/schemas`)
9 event types. `agent_type` and its labels come from one table
(`agent-registry.ts`), which also records which agents have a shipped adapter:
`claude-code`, `opencode`, `codex`, `gemini-cli`, `copilot`, `pi`, `omp` do;
`cursor`, `aider`, `windsurf` are schema entries without one.
Permission modes widened to `normal|plan|accept_edits|auto|dont_ask|bypass` with
an autonomy rank; new `notification.ts` classifier; `alerts.ts` shared rule/severity
constants; expanded git-context (PR CI status, review decision). `scores.ts` is the
single source of scorer identity (a `SCORERS` registry, not string literals at call
sites); `trajectory.ts` holds the six deterministic scorers and `tool-capture.ts` the
content-free `tool_target_hash` / `tool_action` derivation they run on.

### Scoring & evaluation (Phase 13)
Six **deterministic trajectory scorers** — retry loops, edit thrash, redundant reads,
denial-retry success, tests-before-merge, step efficiency — computed from the
content-free capture rather than transcript text, so they need no content access at
all. Skills and MCP servers are first-class scored subjects. A versioned session
rubric captures the owner's own judgement of their own session. An **LLM-as-judge**
exists but is off in three independent ways (seeded disabled, requires two env vars,
restricted to owners who opted in) and is own-sessions-only by a code constant no
deployment configuration can override; every read writes an audit row visible to the
subject. Calibration, the validation surface and judge drift alerting are built but
**blocked on data** — they need ≥10 real users over ≥60 days, ≥200 labelled sessions
and ≥100 outcome-linked PRs, and unblock themselves when that corpus exists.

### Redaction (`packages/redaction`)
**9 rules**, run on both hook and ingest: AWS access/secret keys, GitHub tokens, JWT,
Slack tokens, `*_KEY/_TOKEN/_SECRET/_PASSWORD` env vars, PEM keys, plus
`git-remote-url` (URL-embedded credentials) and `email` (PII). Order is load-bearing —
the structural token rules run first so a known token in a URL's password position
keeps its own class; `email` runs last. ML-grade PII (names, phone numbers) remains
deferred (`DESIGN_DOC §9.2`).

### Auth (`packages/auth`)
GitHub OAuth + device-code + **password (scrypt)**, all GHES-capable. Tokens:
EdDSA JWT access (8 h), rotating refresh (90 d), hook token (365 d). Grant
enforcement helpers (`hasActiveGrant`, `resolveOrgSessionAccess`, …) live in
`apps/web` and gate every org/individual session + transcript read.

---

## 7. Non-goals — the guardrails

- **No multi-tenancy** (single-org by design).
- **No real-time / streaming alerting or SIEM.** Phase 9 added *scheduled,
  aggregate-level* alerting only — real-time remains out of scope.
- **No model-level observability** (latency / drift / RAG) — "a different product."
- **No vanity metrics:** "lines of code generated" and "% of code written by AI"
  are explicitly rejected. Outcome-based ROI (cost-per-merged-PR, revert/rework
  spend, CI-clean rate) is the sanctioned framing — now shipped at `/org/roi`.
- **Deferred (not rejected):** external business-value joins beyond Jira (Linear /
  revenue) — the Jira per-issue value join now ships via `JIRA_VALUE_FIELD`;
  bug-correlation, IDE telemetry joins,
  Cursor/Aider/Windsurf adapters (schema-ready, no adapter), semantic
  transcript search (declined pending a proven gap + self-hosted embeddings),
  vendor cost reconciliation (scaffolded, gated).

---

## 8. Known gaps & seams — where new requirements land

Gaps from the prior snapshot that are now **closed:** git-at-session-start capture,
transcript viewer redesign, friction/shape surfacing, `/install` page, self-service
transcript search, and most of the `OPPORTUNITIES.md` backlog — model-routing
recommendations (`/org/models`), the security/exposure dashboard (`/org/security`,
incl. secret-exposure by persisted `redaction_flags`), budget/spend forecasting
(`/org/dashboard`), knowledge-gap clustering (`/org/knowledge`), and cohort/
shape-shift effectiveness views. Also now closed: the **Jira per-issue
business-value join** (`JIRA_VALUE_FIELD` → `jira_issues.business_value`, preferred
over the flat proxy on `/org/roi`), **redaction-class historical backfill** (the
operator-triggered `backfill-redaction` job), and **per-team routing accountability**
(premium-on-retrieval spend on `/org/models`). Current open items:

| Gap / seam | Where | Architectural implication |
|---|---|---|
| **External business-value join beyond Jira** (Linear / revenue) | product | The Jira per-issue value join now ships (`JIRA_VALUE_FIELD`); a Linear/revenue/business-outcome source is the remaining piece for non-Jira shops. |
| **Model-routing *blocking* enforcement** | hook | The `routing_waste` alert + per-team routing-accountability table make waste actionable, but hook-side auto-route/block is intentionally out of scope — the platform is observe-only (`DESIGN_DOC §10.3a`: nothing intercepts a live tool call). "Enforcement" here is visibility + accountability + alert. |
| **Cost reconciliation beyond Anthropic and GitHub** | ingest `reconcile-cost` | Two vendor clients ship (`AnthropicBillingSource`, Admin Cost Report API; `GitHubBillingSource`, AI-credit usage report); other vendors (e.g. OpenAI for Codex) still have no billing source. Both existing ones are org-wide — no vendor billing API we have found attributes spend to a developer. |
| **Semantic search prototype gated** (P7-007 no-go) | `sql/prototypes/`, `embed-transcripts` | Requires a self-hosted embedding path + a proven recall gap to revisit. |
| **Redaction: ML-grade PII (names, phone numbers)** | `packages/redaction` | Regex `email` and `git-remote-url` (URL-embedded credentials) rules now ship; name/phone detection would need an ML pass (deferred, `DESIGN_DOC §9.2`). |
| **Grant expiry enforced at read-time, not swept** | `apps/web` grant helpers | No background revocation job; fine today, worth noting for audit completeness. |
| **Cursor, Aider and Windsurf are schema-only** | hook adapters | Multi-vendor comparison at `/org/agents` needs their adapters + telemetry contract. |
| **github-app ignores draft-only PR transitions** | `handlers/pull-request.ts` | `ready_for_review`/`converted_to_draft` don't trigger upsert; `is_draft` lags until next push/close. |

### Open task items (mostly manual/external)
- **P1-029** — Phase 1 dogfood sign-off. **P2-001** — GitHub App registration.
  **P2-010** — GHES integration test. **P6-005/P6-006** — deferred, superseded by P8.
- P9 roadmap exit-criteria checkboxes are unchecked in the file even though tasks
  are marked done — verify before citing them as met.

---

## 9. How this shapes new requirements

Three architectural invariants any new spec must respect:

1. **Privacy & governance are load-bearing, not features.** Reading another
   user's data must pass through `visibility_policies`, an **active `access_grant`
   (or ownership/admin)**, *and* an `audit_log` write (CI fails cross-user reads
   without one). New cross-user surfaces inherit this or they break the trust
   thesis. Prefer aggregate-first; individual drill-down is a separate access
   decision.
2. **`packages/schemas` is the single wire contract** across hook / ingest / web —
   new telemetry shapes start there, cost goes through per-agent price tables, and
   any user-pasted content **must** add a `packages/redaction` rule.
3. **Agent-neutrality is now proven, not aspirational.** New capabilities branch on
   `agent_type`, use `<agent>:<tool>` naming, and drive user-facing copy from the
   agent label — the hook adapter seam, per-agent pricing, and de-Claude-ified UI
   already exist. Adding an agent = a new adapter, not a schema change.

**Expansion vectors, ranked by leverage-to-cost** (aligned with `OPPORTUNITIES.md`).
Vectors 1–4 from the prior snapshot have now shipped — model-routing
recommendations, the security/exposure dashboard, budget/spend forecasting, and
deeper effectiveness (cohort divergence + shape-shift). What remains:

1. **Perfect the shipped surfaces** — redaction-class historical backfill now
   ships (the operator-triggered `backfill-redaction` job scans stored
   transcripts for `[REDACTED:<class>]` markers). The tool/model aggregates carry
   `user_id`; routing-savings estimates use the real price table — all done.
2. **Routing accountability, not blocking** — the `routing_waste` alert plus a
   per-team routing-accountability table on `/org/models` make premium-on-retrieval
   waste actionable. Hook-side auto-route/block stays out of scope by design (the
   platform is observe-only, `DESIGN_DOC §10.3a`).
3. **External business-value join** — the Jira per-issue value join now ships
   (`JIRA_VALUE_FIELD` → `jira_issues.business_value`, preferred over the flat
   per-point proxy on `/org/roi`); a Linear/revenue/outcome source remains the
   piece for non-Jira shops.
4. **Heavier deferred items** — the remaining agent adapters (Cursor, Amp,
   Aider, Windsurf — each deferred for a stated reason in `tasks/P12-roadmap.md`),
   vendor cost reconciliation, semantic search (if a gap is proven), IDE telemetry
   joins.

---

*Generated from a structured investigation of the codebase, design docs, and the
P1–P12 task breakdown.*
