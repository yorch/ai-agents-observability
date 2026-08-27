# ai-agents-observability — Design Document

**Project:** `ai-agents-observability`
**Status:** Phases 1–9, 11 and 12 are done; Phase 10 is partly shipped and reconciled per task (§12.10); Phase 13 (scoring & evaluation) is done apart from its analysis and judge-arming tasks, which are `blocked` by design on a stated data precondition. Remaining open task statuses are operational sign-off / integration items in P1–P2 plus P6 deferrals superseded by P8
**Owner:** Jorge (SentinelOne)
**Last updated:** 2026-08-14 (see §17 — keep this in step with the last row of the history table)
**Audience:** Internal — dev tools team, leadership stakeholders

---

## 1. Executive Summary

`ai-agents-observability` is a self-hosted observability platform for AI coding agents — Claude Code first, with adapters now implemented for opencode, Codex CLI, Gemini CLI, GitHub Copilot CLI, Pi and omp. The data model remains designed to accommodate Cursor, Aider, and other agentic developer tools later. It ingests per-event telemetry from developer machines, archives full session transcripts, correlates work to pull requests and GitHub teams, and exposes dashboards and reporting for three audiences: individual developers, team leads, and org-level stakeholders.

The scope deliberately sits between two larger industry buckets. It is **not** model observability (inference latency, prompt eval, drift) and it is **not** generic AI observability (which sprawls across RAG quality, embeddings, fine-tuning, etc.). The narrower target is **how humans use AI coding agents to do real engineering work** — sessions, tools, skills, MCP servers, PR outcomes.

The primary purpose is **developer experience and effectiveness research** (audience B) and **self-service visibility for individual devs** (audience C), with a secondary goal of **cost attribution** (audience A). Default design choices favor developer trust over surveillance: least-exposure defaults, audit logs on privileged access, and a "My Agents" experience that is genuinely useful to the individual before any team or org rollups exist.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Capture per-event telemetry from supported coding-agent sessions: tool usage, skills, MCP servers, subagents, model selection, tokens, cost, errors, permission events, mode switches, slash commands.
- Capture full session transcripts for retrospective analysis and search.
- Correlate sessions to git context (repo, branch, commit, dirty state) and to GitHub pull requests.
- Provide rollups at the PR level — cost-per-PR, sessions-per-PR, tool mix, time-to-merge.
- Expose a self-service "My Agents" experience for every dev to see and manage their own data.
- Support team-scoped and org-scoped views with configurable per-user privacy controls.
- Integrate with GitHub for identity (OAuth), team membership, PR enrichment, and PR-comment reporting.
- Self-hosted deployment on existing infrastructure (homelab / on-prem capable).

### 2.2 Non-Goals (v1)

- Multi-tenancy. This is single-org, single-tenant.
- Real-time alerting / SIEM-style behavioral analytics on session content. *(Update: threshold-based operational alerting is implemented in Phase 9 §12.9. All six rule types are evaluated — `spend_spike`, `high_error_rate`, `unknown_model_surge`, `autonomy_surge`, `budget_threshold` and `routing_waste`; the last two are seeded **disabled**, since neither means anything until an operator picks a threshold. SIEM-style behavioral analytics on transcript content remains out of scope.)*
- Replacing any existing observability stack (Datadog, Splunk, etc.) — this is purpose-built for AI coding agent telemetry.
- **Model-level observability** — inference latency, prompt evaluation, model drift, RAG quality. Out of scope by design; that's a different product. *(Clarified 2026-08-12: this non-goal covers **model/agent benchmarking** — ranking models or agents, running task suites, counterfactual re-runs. It does **not** cover evaluating the platform's own computed signals against real engineering outcomes, which is a goal and is decomposed in Phase 13 (`tasks/P13-roadmap.md`). The distinction, and why `friction_score`/`shape_label` are already unvalidated evals, is argued in `docs/research/2026-08-12-llm-evals-assessment.md`.)*
- Capturing telemetry from every possible coding agent. Seven adapters ship (Claude Code, opencode, Codex, Gemini CLI, Copilot CLI, Pi, omp); Cursor, Aider and Windsurf remain future adapters, each deferred for a stated reason (see `tasks/P12-roadmap.md`).
- Computing line-of-code-generated style "AI productivity" headline numbers (explicitly avoided — see §10).

### 2.3 Explicitly Deferred

- Bug correlation (link bugs in Jira/Linear back to AI-touched PRs). *(Update: the data foundation now exists — `jira_issues` is synced by the env-gated `sync-jira` job, sessions carry their own `jira_key`, and issue type/status/epic are queryable. The correlation analysis surface itself remains deferred.)*
- IDE telemetry joins (overlap with VSCode/Cursor sessions).
- CI / lint / test failure correlation via GitHub Checks API. *(Update: implemented — P5-005 added the failure counter; per-run outcomes are now stored in `pr_check_runs`.)*
- Revert detection through git history scanning. *(Update: default-branch `push` webhooks now correlate commits to sessions in `session_commit_links`; full history scanning remains deferred.)*
- Capture from CI-side agent runs (v1 focuses on interactive developer sessions).
- Cursor / Aider / Windsurf adapters (deferred; data model is forward-compatible).

### 2.4 Multi-Agent Extensibility

The name `ai-agents-observability` is deliberately plural. Claude Code was the first agent integrated, Phase 8 added opencode plus Codex, and Phase 12 added Gemini CLI, Copilot CLI, Pi and omp. Every schema decision in this document is made with the assumption that more agents will be added later.

Concretely, this means:

- An `agent_type` dimension exists on every event and session (defaulting to `CLAUDE_CODE` in v1). The enum as shipped: `CLAUDE_CODE`, `CURSOR`, `AIDER`, `COPILOT`, `CODEX`, `WINDSURF`, `OPENCODE`, `GEMINI_CLI`, `PI`, `OMP` — defined once in `packages/schemas/src/agent-registry.ts`, which also records which of them have a shipped adapter. Live adapters: `CLAUDE_CODE`, `OPENCODE` (P8-004), `CODEX` (P8-007, moved onto Codex's native lifecycle hooks in P12-004), `GEMINI_CLI`, `COPILOT`, `PI`, `OMP` (P12). `CURSOR`, `AIDER` and `WINDSURF` have schema entries but no adapter yet.
- Tool naming uses a `<agent>:<tool>` convention internally to prevent collisions when other agents have similarly-named tools (e.g. `CLAUDE_CODE:Edit` vs `CURSOR:Edit`)
- The hook contract (§6.3) is agent-agnostic — any agent that can emit equivalent lifecycle events can produce conformant payloads via its own adapter (see §6.2 for the adapter seam)
- "My Agents" (the self-service dashboard, §8) is named for the plural case from day one
- Cost computation accepts per-agent price tables, not a global one

---

## 3. Audiences & Use Cases

Three audiences, with different needs and access levels.

| Audience                     | Primary Question                                                               | Default Access                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **A — Leadership / Finance** | "What is Claude Code costing us, and where?"                                   | Aggregates only — no individual session access                         |
| **B — Dev Tools / Research** | "Is it working? Where are the friction points? What patterns predict success?" | Org-wide aggregates + sampled session investigation with audit logging |
| **C — Individual Developer** | "How am I using Claude? What's my cost? What am I sharing?"                    | Full access to own data; privacy controls                              |

The design optimizes for **B and C primary, A secondary**. The "My Agents" page is the trust anchor — if developers find their own page genuinely useful, adoption follows. If the first thing they see is a manager's dashboard with their name on it, the project fails politically.

---

## 4. Architecture Overview

Three logical planes, separated by access pattern.

### 4.1 Ingest Plane

Stateless, horizontally scalable. Two endpoints:

- `POST /v1/events` — batched JSON event payloads from client hooks
- `POST /v1/transcripts/{session_id}` — chunked transcript upload, supports `Content-Range` for resumable uploads

Auth: short-lived access tokens issued via the OIDC flow described in §6. No long-lived API keys.

### 4.2 Storage Plane

Split by access pattern:

- **Postgres** — dimensions (users, teams, repos), sessions, PR rollups, audit log, visibility policies. Transactional, queryable surface for the UI.
- **Postgres + TimescaleDB hypertable** — high-volume events firehose. (Decision: Timescale over ClickHouse for v1 — see §11.1.)
- **S3-compatible object store (MinIO)** — raw transcript JSONL, zstd-compressed, keyed by session ID. Lifecycle rules for retention. MinIO for local dev and homelab prod; any S3-compatible store for cloud prod.

### 4.3 Query / API / UI Plane

Read-only service that fronts:

- The dashboard UI (Next.js / React)
- Search API (faceted + full-text over transcripts within visibility scope)
- Export endpoints (CSV, JSON, filtered by scope)
- A GitHub bot service that posts PR-merge summary comments

### 4.4 Data Flow

```
[Dev machine: Claude Code]
       │
       │ hooks fire (PreToolUse, PostToolUse, Stop, etc.)
       ▼
[claude-telemetry hook binary]
       │ writes to local queue (sqlite or JSONL)
       │ batches every 5s / 50 events
       ▼
[Ingest API: POST /v1/events] ──► [Timescale: events hypertable]
                                        │
                                        ▼
                                 [Postgres: sessions table, incremental aggregates]
       │
       │ at Stop + periodic heartbeat
       ▼
[Transcript shipper: redact → zstd → upload]
       │
       ▼
[POST /v1/transcripts/{sid}] ──► [MinIO/S3: transcripts/{yyyy}/{mm}/{dd}/{sid}.jsonl.zst]
                                        │
                                        ▼
                                 [Postgres: sessions.transcript_s3_key]

[GitHub webhooks: PR opened/synced/merged]
       │
       ▼
[Webhook receiver] ──► [Postgres: pull_requests, session_pr_links]
                              │
                              ▼
                       [PR rollup compute] ──► [Postgres: pr_rollups]
                              │
                              ▼
                       [PR bot: post merge summary comment to GitHub]
```

---

## 5. Data Model

### 5.1 Dimensions (Postgres)

**`users`** — identity sourced from GitHub OAuth + nightly team sync.

```sql
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_login        TEXT UNIQUE NOT NULL,
  github_id           BIGINT UNIQUE NOT NULL,
  email               TEXT,
  display_name        TEXT,
  primary_team_id     UUID REFERENCES teams(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ,
  deactivated_at      TIMESTAMPTZ
);
CREATE INDEX ON users (last_seen_at);
```

**`teams`** — mirrors GitHub teams; nested teams supported.

```sql
CREATE TABLE teams (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_slug         TEXT UNIQUE NOT NULL,
  github_id           BIGINT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  parent_team_id      UUID REFERENCES teams(id),
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id             UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_team        TEXT NOT NULL CHECK (role_in_team IN ('MEMBER','LEAD','MAINTAINER')),
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX ON team_members (user_id);
```

**`repos`** — dimension table; populated lazily as sessions report cwd/remote.

```sql
CREATE TABLE repos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_owner        TEXT NOT NULL,
  github_name         TEXT NOT NULL,
  github_id           BIGINT UNIQUE,
  default_branch      TEXT,
  owning_team_id      UUID REFERENCES teams(id),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (github_owner, github_name)
);
```

**`visibility_policies`** — per-user privacy controls. Conservative defaults.

```sql
CREATE TABLE visibility_policies (
  user_id                         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  share_metadata_with_team        BOOLEAN NOT NULL DEFAULT true,
  share_metadata_with_org         BOOLEAN NOT NULL DEFAULT true,
  share_transcripts_with_team     BOOLEAN NOT NULL DEFAULT false,
  share_transcripts_with_org      BOOLEAN NOT NULL DEFAULT false,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`audit_log`** — every privileged view of someone else's data.

```sql
CREATE TABLE audit_log (
  id                  BIGSERIAL PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id       UUID NOT NULL REFERENCES users(id),
  action              TEXT NOT NULL,    -- 'view_session','view_transcript','export_team', etc.
  target_user_id      UUID REFERENCES users(id),
  target_session_id   UUID,
  target_team_id      UUID REFERENCES teams(id),
  justification       TEXT,
  ip                  INET,
  user_agent          TEXT
);
CREATE INDEX ON audit_log (target_user_id, ts DESC);
CREATE INDEX ON audit_log (actor_user_id, ts DESC);
```

### 5.2 Sessions (Postgres)

One row per Claude Code session. `session_id` comes from Claude Code; do not regenerate.

```sql
CREATE TABLE sessions (
  session_id              UUID PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES users(id),

  -- Agent dimension (forward-compatible; defaults to CLAUDE_CODE in v1)
  agent_type              TEXT NOT NULL DEFAULT 'CLAUDE_CODE',
  agent_version           TEXT,

  -- Lifecycle
  started_at              TIMESTAMPTZ NOT NULL,
  ended_at                TIMESTAMPTZ,
  last_event_at           TIMESTAMPTZ NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN
                            ('ACTIVE','COMPLETED','CRASHED','TIMED_OUT','ABANDONED')),
  end_reason              TEXT,

  -- Resume / chaining
  is_resume               BOOLEAN NOT NULL DEFAULT false,
  resumed_from_session_id UUID,
  compaction_count        INT NOT NULL DEFAULT 0,
  clear_count             INT NOT NULL DEFAULT 0,

  -- Client environment
  host_hash               TEXT,
  claude_code_version     TEXT,         -- legacy alias; superseded by agent_version
  os                      TEXT,
  cwd                     TEXT,

  -- Git context (captured client-side at SessionStart)
  repo_id                 UUID REFERENCES repos(id),
  git_branch              TEXT,
  git_commit              TEXT,
  git_remote_url          TEXT,
  git_is_dirty            BOOLEAN,
  pr_number               INT,

  -- Aggregates (updated incrementally as events arrive)
  total_input_tokens      BIGINT NOT NULL DEFAULT 0,
  total_output_tokens     BIGINT NOT NULL DEFAULT 0,
  total_cache_read        BIGINT NOT NULL DEFAULT 0,
  total_cache_creation    BIGINT NOT NULL DEFAULT 0,
  total_cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,

  tool_call_count         INT NOT NULL DEFAULT 0,
  tool_error_count        INT NOT NULL DEFAULT 0,
  permission_prompt_count INT NOT NULL DEFAULT 0,
  permission_deny_count   INT NOT NULL DEFAULT 0,
  interrupt_count         INT NOT NULL DEFAULT 0,
  user_message_count      INT NOT NULL DEFAULT 0,

  -- Model mix
  primary_model           TEXT,

  -- Transcript pointer
  transcript_s3_key       TEXT,
  transcript_bytes        BIGINT,
  transcript_uploaded_at  TIMESTAMPTZ,
  transcript_redacted     BOOLEAN NOT NULL DEFAULT false,
  redaction_flags         TEXT[] NOT NULL DEFAULT '{}',  -- redaction classes detected at ship time (populated by the ingest pipeline; historical rows backfilled by the operator-triggered backfill-redaction job); drives /org/security secret-exposure-by-class

  -- Effectiveness signals (computed by ingest scheduler; see §10.2)
  shape_label             TEXT,         -- 'exploratory'|'implementation'|'debugging'|'planning'
  friction_score          NUMERIC(5,2), -- composite: retries + denials + interrupts + abandonment

  -- GitHub enrichment (populated from webhook context)
  pr_ci_status            TEXT,         -- last check-run conclusion for the PR (P5-005)
  pr_review_decision      TEXT,         -- 'APPROVED'|'CHANGES_REQUESTED'|'REVIEW_REQUIRED' (P5-005)
  github_login            TEXT,         -- denormalized from users for fast filtering
  github_team             TEXT,         -- primary team name at session start (hook-reported)
  team_id                 UUID REFERENCES teams(id), -- resolved FK for github_team (ingest; unambiguous names only)
  project_name            TEXT,         -- display name derived from repo/cwd
  jira_key                TEXT          -- extracted from git_branch at ingest (session-level ticket attribution)
);
CREATE INDEX ON sessions (user_id, started_at DESC);
CREATE INDEX ON sessions (repo_id, started_at DESC);
CREATE INDEX ON sessions (pr_number) WHERE pr_number IS NOT NULL;
CREATE INDEX ON sessions (status, last_event_at);
CREATE INDEX ON sessions (agent_type, started_at DESC);
```

### 5.2a Scores (Postgres) — the scoring substrate

Added in Phase 13 (P13-001). Every computed signal — heuristic, deterministic, human, or judge — is a row here carrying *which scorer produced it* and *at what version*. Before this, each signal was a hard-wired column on `sessions` with no scorer identity and no version, which made calibration impossible and every scorer change a bespoke backfill job.

```sql
CREATE TABLE scores (
  id             UUID PRIMARY KEY,
  subject_type   "ScoreSubjectType" NOT NULL,   -- SESSION | PULL_REQUEST | SKILL | MCP_SERVER
  subject_id     TEXT NOT NULL,                  -- heterogeneous: session uuid, skill name, …
  scorer_name    TEXT NOT NULL,
  scorer_version INT  NOT NULL,
  source         "ScoreSource" NOT NULL,         -- HEURISTIC | DETERMINISTIC | HUMAN | JUDGE | OUTCOME
  value          DOUBLE PRECISION,               -- numeric scorers
  label          TEXT,                           -- categorical scorers
  metadata       JSONB NOT NULL DEFAULT '{}',    -- provenance only; never raw content
  rationale_ref  TEXT,                           -- pointer (e.g. S3 key), never inline text
  cost_usd       NUMERIC(12,6),                  -- judge/eval spend, in the platform's own dashboards
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, scorer_name, scorer_version)
);
```

`sessions.friction_score` / `shape_label` remain as a denormalized *current value* cache, so every existing dashboard, facet and query is untouched; this table holds the history and the provenance. `packages/schemas/src/scores.ts` is the single source of scorer identity — a `SCORERS` registry, not string literals at call sites. Scores carry no FK (the subject is heterogeneous), so session-scoped rows are deleted explicitly by `run-deletions`.

Field names lean toward the emerging OpenTelemetry GenAI *evaluation event* so a future bridge is a mapping rather than a migration — deliberately without adopting it, since nothing in that spec is marked Stable.

### 5.2b Run kind

`sessions.run_kind` and `events.run_kind` (`INTERACTIVE` | `CI` | `EVAL`, default `INTERACTIVE`) separate developer sessions from non-human agent runs (P13-002). This resolves §13 Q8's concern directly: CI runs no longer *would* distort the aggregates, because every read that produces a human aggregate filters to `INTERACTIVE`. The filter is centralized in `apps/web/src/lib/run-kind.ts` and `apps/ingest/src/lib/run-kind.ts`, baked into the three continuous-aggregate definitions, and enforced by source-scanning tests in both apps rather than by review.

Three classes of read are deliberately *not* filtered, and the distinction is the point: a per-session drill-down (a query scoped to one id is not a population — filtering it would empty the session's own detail page rather than exclude it from anything); the mechanical jobs that operate on rows rather than people (retention sweeps, transcript indexing, redaction backfill); and the per-session scorers, since a CI session's friction score is a property of that session. The rule is "no non-human run in a number about humans", not "no non-human run anywhere".

Optional on the wire, so no hook binary needs a version bump; nothing is granted by the claim, so a client that lies only removes its own data.

### 5.2c Human labels and projections (Postgres)

Two small tables that exist so the platform can be checked against reality rather than trusted.

`session_feedback` is the owner's own answer about their own session. It predates Phase 13 as a bare `sentiment` + `note`; P13-005 added `rubric_version` and made `sentiment` nullable, since "how did this feel" and "did it work" are distinct questions and gating the row on a thumbs would delete a rubric answer when someone cleared their thumbs. **The rubric answers themselves are not columns here** — they are `scores` rows (`human_session_shape`, `human_task_outcome`, `source: HUMAN`), because calibration reads one table. `rubric_version` stays on the row because no score row can express it: "answered version 1 and declined both questions" and "predates the rubric" are different facts that an absent score row cannot distinguish.

`projections` records a prediction so it can be graded later:

```sql
CREATE TABLE projections (
  id                   UUID PRIMARY KEY,
  claim_type           TEXT NOT NULL,      -- vocabulary defined by the registry
  segment              TEXT NOT NULL,      -- a model id, a team slug, "org"
  projected_low        DOUBLE PRECISION NOT NULL,   -- a RANGE, never a point estimate
  projected_high       DOUBLE PRECISION NOT NULL,
  unit                 TEXT NOT NULL,      -- so realization cannot compare unlike things
  baseline_value       DOUBLE PRECISION NOT NULL,
  baseline_window_days INT NOT NULL,
  period_start         TIMESTAMPTZ NOT NULL,
  period_end           TIMESTAMPTZ NOT NULL,
  price_table_version  TEXT,               -- replay apples-to-apples: a price-table
  scorer_versions      JSONB NOT NULL DEFAULT '{}',  -- or scorer change is not a result
  guard_baseline       JSONB NOT NULL DEFAULT '{}',  -- friction / error / revert at claim time
  metadata             JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Two columns rather than a value-plus-margin so a degenerate range cannot be expressed by omission, and `guard_baseline` so a saving that arrived alongside rising friction is flagged instead of celebrated. Realization refuses to compare until `period_end` has closed.

### 5.3 Events Firehose (Timescale Hypertable)

Every hook fire. Partitioned by day.

```sql
CREATE TABLE events (
  event_id              UUID NOT NULL,            -- UUIDv7, client-generated
  session_id            UUID NOT NULL,
  user_id               UUID NOT NULL,
  ts                    TIMESTAMPTZ NOT NULL,

  -- Agent dimension
  agent_type            TEXT NOT NULL DEFAULT 'CLAUDE_CODE',

  event_type            TEXT NOT NULL,
    -- SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
    -- PreCompact, Notification, Stop, SubagentStop, SessionEnd
  turn_number           INT,
  parent_event_id       UUID,

  -- Tool dimension
  tool_name             TEXT,
  tool_category         TEXT,
    -- 'fs_read','fs_write','exec','search','web','task','mcp','other'
  tool_input_hash       TEXT,                     -- sha256 of input, never the input itself
  tool_input_bytes      INT,
  tool_output_bytes     INT,
  tool_duration_ms      INT,
  tool_exit_status      INT,
  tool_was_denied       BOOLEAN,
  tool_was_interrupted  BOOLEAN,
  tool_target_hash      TEXT,                     -- non-reversible digest of WHAT was acted on
  tool_use_id           TEXT,                     -- the agent's own per-call id; the turn-linkage join key (P14-006)
  tool_action           TEXT,                     -- coarse class for shell commands ('test','vcs',…)

  -- MCP detail
  mcp_server            TEXT,
  mcp_tool              TEXT,

  -- Subagent detail
  subagent_type         TEXT,

  -- Skill detection
  skill_name            TEXT,
  skill_path            TEXT,

  -- Slash command
  slash_command         TEXT,

  -- LLM accounting
  model                 TEXT,
  input_tokens          INT,
  output_tokens         INT,
  cache_read_tokens     INT,
  cache_creation_tokens INT,
  cost_usd              NUMERIC(12,6),

  mode                  TEXT,                     -- 'normal','plan','accept_edits'
  notification_kind     TEXT,                     -- why the agent interrupted the human
  run_kind              TEXT NOT NULL DEFAULT 'INTERACTIVE',  -- INTERACTIVE | CI | EVAL (§5.2b)

  metadata              JSONB,                    -- provenance only; never raw content (§9.3)

  PRIMARY KEY (session_id, event_id, ts)
);
SELECT create_hypertable('events', 'ts', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON events (user_id, ts DESC);
CREATE INDEX ON events (session_id, ts);
CREATE INDEX ON events (tool_name, ts DESC) WHERE tool_name IS NOT NULL;
CREATE INDEX ON events (mcp_server, ts DESC) WHERE mcp_server IS NOT NULL;
CREATE INDEX ON events (skill_name, ts DESC) WHERE skill_name IS NOT NULL;
CREATE INDEX ON events (agent_type, ts DESC);
CREATE INDEX ON events (notification_kind, ts DESC) WHERE notification_kind IS NOT NULL;
CREATE INDEX ON events (run_kind, ts DESC) WHERE run_kind <> 'INTERACTIVE';
```

`tool_target_hash` and `tool_action` are the **content-free capture** the trajectory scorers (§5.2a, P13-003) run on: a two-lane digest of *what* a call acted on — file path for file tools, normalized command shape for shell — and a coarse action class. Neither is reversible, and neither is the tool input or output. They are what makes "this session read the same file four times" and "this edit was thrashed" computable without the platform ever holding the content. `run_kind`'s index is **partial on the non-default value**, since the interesting query is always "show me the runs that are *not* interactive".

**Compression:** A 7-day compress policy runs on the hypertable, segmented by `(user_id, session_id)`.

**Continuous aggregates (materialized, 1-hour refresh):**
- `daily_cost_by_user` — `(day, user_id, agent_type)` → token totals and cost
- `daily_cost_by_model` — `(day, user_id, model, agent_type)` → token totals, cost, session count
- `daily_tool_usage` — `(day, user_id, tool_name, tool_category, agent_type)` → call counts

All three carry `user_id`, so every org rollup that reads them can be visibility-scoped (`WHERE user_id IN (sharers)`) exactly like the raw-events queries. All three are also defined `WHERE run_kind = 'INTERACTIVE'`, so a CI or eval run cannot enter a developer-facing rollup even if a query forgets to filter — an aggregate named `daily_cost_by_user` that feeds a developer dashboard should not be *able* to contain non-human runs.

### 5.4 Pull Requests & Rollups (Postgres)

```sql
CREATE TABLE pull_requests (
  repo_id             UUID NOT NULL REFERENCES repos(id),
  pr_number           INT NOT NULL,
  github_id           BIGINT UNIQUE NOT NULL,
  title               TEXT,
  author_user_id      UUID REFERENCES users(id),
  author_github_login TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','MERGED')),
  base_branch         TEXT,
  head_branch         TEXT,
  opened_at           TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  merged_at           TIMESTAMPTZ,
  lines_added         INT,
  lines_removed       INT,
  files_changed       INT,
  review_count        INT,
  reviewer_logins     TEXT[],
  labels              TEXT[],
  enriched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_draft            BOOLEAN NOT NULL DEFAULT false,
  reverted_at         TIMESTAMPTZ,        -- set if this PR was reverted (P5-003)
  revert_of_pr_number INT,               -- if this PR is itself a revert (P5-003)
  jira_key            TEXT,              -- extracted from branch/title if org uses Jira (P5-004)
  PRIMARY KEY (repo_id, pr_number)
);

CREATE TABLE session_pr_links (
  session_id          UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  repo_id             UUID NOT NULL,
  pr_number           INT NOT NULL,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  link_source         TEXT NOT NULL CHECK (link_source IN
                        ('session_start','webhook_reconcile','manual')),
  PRIMARY KEY (session_id, repo_id, pr_number),
  FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, pr_number)
);
CREATE INDEX ON session_pr_links (repo_id, pr_number);

Session↔PR linking (P2-004, hardened): the merge-time backfill matches sessions by exact
head-branch name **or** by the session's start commit appearing in the PR's commit list
(fetched via the installation token; survives rebases/renames/squash merges). The
backfill also runs on `opened`/`synchronize` (branch match only, no API call) so open
PRs link before merge, and the lookback window is configurable via
`PR_LINK_LOOKBACK_DAYS` (default 7). The `MANUAL` link source is written by the
"My Agents" session-detail page (own sessions only), which recomputes the PR rollup.

```sql
-- Per-check-run outcome history (extends the P5-005 failure counter)
CREATE TABLE pr_check_runs (
  id                  BIGSERIAL PRIMARY KEY,
  repo_id             UUID NOT NULL,
  pr_number           INT NOT NULL,
  github_id           BIGINT NOT NULL,     -- check_run id; upserted across queued→completed
  name                TEXT NOT NULL,
  status              TEXT NOT NULL,
  conclusion          TEXT,
  head_sha            TEXT,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  UNIQUE (repo_id, pr_number, github_id),
  FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, pr_number)
);

-- Submitted PR reviews (pull_request_review webhook); review_count is maintained from these
CREATE TABLE pr_reviews (
  id                  BIGSERIAL PRIMARY KEY,
  repo_id             UUID NOT NULL,
  pr_number           INT NOT NULL,
  github_id           BIGINT UNIQUE NOT NULL,
  reviewer_login      TEXT NOT NULL,
  state               TEXT NOT NULL,       -- APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  submitted_at        TIMESTAMPTZ,
  FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, pr_number)
);

-- Commit→session correlation from default-branch push webhooks (§7.2)
CREATE TABLE session_commit_links (
  session_id          UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  repo_id             UUID NOT NULL,
  commit_sha          TEXT NOT NULL,
  author_login        TEXT,
  committed_at        TIMESTAMPTZ,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, repo_id, commit_sha)
);

-- Jira issue metadata, synced by the env-gated sync-jira job (§6.5).
-- pull_requests.jira_key / sessions.jira_key reference `key` as a plain string.
CREATE TABLE jira_issues (
  key                 TEXT PRIMARY KEY,
  summary             TEXT,
  issue_type          TEXT,
  status              TEXT,
  epic_key            TEXT,
  project_key         TEXT,               -- also the key prefix (PLAT-123 → PLAT); indexed for project rollups
  project_name        TEXT,               -- API-sourced display name; not derivable from the key
  story_points        DOUBLE PRECISION,
  assignee            TEXT,
  resolved_at         TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pr_rollups (
  repo_id                  UUID NOT NULL,
  pr_number                INT NOT NULL,
  contributing_user_ids    UUID[],
  contributing_session_ids UUID[],
  first_session_at         TIMESTAMPTZ,
  last_session_at          TIMESTAMPTZ,
  total_active_seconds     INT,
  total_cost_usd           NUMERIC(12,6),
  total_input_tokens       BIGINT,
  total_output_tokens      BIGINT,
  total_tool_calls         INT,
  total_tool_errors        INT,
  total_permission_denies  INT,
  cost_per_loc             NUMERIC(12,6),
  check_failures_count     INT,           -- CI check failures at merge time (P5-005)
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, pr_number)
);
```

### 5.5 Transcript Index (Postgres FTS)

Populated by the `index-transcripts` scheduled job in `apps/ingest`. Used by both per-user search (`/me/search`) and org-scoped search (`/org/search`).

```sql
CREATE TABLE transcript_index (
  session_id      UUID NOT NULL,
  message_idx     INT NOT NULL,
  role            TEXT NOT NULL,
  ts              TIMESTAMPTZ,
  content_text    TEXT,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED,
  PRIMARY KEY (session_id, message_idx)
);
CREATE INDEX ON transcript_index USING GIN (content_tsv);
```

For larger scale, swap Postgres FTS for Meilisearch or Typesense. The `index-transcripts` job only indexes sessions whose transcripts are within the user's visibility scope.

---

## 6. Capture Mechanism

### 6.1 Why Hybrid

Claude Code exposes telemetry through several surfaces; they are not equivalent.

| Surface                                                                                                           | Strengths                                            | Weaknesses                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| **OpenTelemetry export** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`)                                                       | Built-in, structured metrics + logs                  | Aggregated/event-level, not full transcripts                |
| **Hooks** (PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit, PreCompact, SubagentStop, Notification) | Rich per-event JSON, full lifecycle coverage         | No transcript content                                       |
| **Session transcripts on disk** (`~/.claude/projects/<encoded>/<session_id>.jsonl`)                               | Complete conversation, every message and tool result | Big, unstructured for analytics, must be shipped separately |
| **`claude --resume` / session export**                                                                            | Programmatic session pull                            | Snapshot-in-time, not streaming                             |

**Decision:** Use hooks for real-time event capture + transcript shipper for full-record archival. OTel is optional and could feed metric-style dashboards later.

### 6.2 Hook Binary

A Bun-compiled static binary (`bun build --compile`), distributed via existing dev-machine config / dotfiles / MDM. Produces a self-contained executable with Bun's runtime bundled — no Node/Bun installation required on the target machine.

Responsibilities:

- Implement each hook entrypoint as a thin shim that writes a JSONL record to a local queue
- Batch flush to ingest API every 5 seconds or every 50 events, whichever first
- Retry on network failure with exponential backoff
- Periodic transcript heartbeat (every 10 min) for long-running sessions
- Final transcript ship on `Stop` / `SessionEnd`
- Local CLI: `install` (register hooks), `uninstall` (remove hooks), `login` (OIDC device-code flow), `status` (queue depth + connectivity), `pause` / `resume` (toggle flushing), `purge` (clear local queue + optional local transcripts), `import` (backfill historical transcripts from `~/.claude/projects/`)
- **Hook adapter seam** (Phase 8, extended in Phase 12): each agent has its own adapter — `claude-code`, `codex`, `gemini-cli`, `copilot`, `pi`, `omp`, `opencode`. The transport (batching, queue, flushing, auth) is shared; adapters handle event translation. An optional `mapBatch` lets one hook fire expand into multiple events (used by the Codex adapter to read rollout JSONL, by Gemini to fold per-call token usage onto the turn's Stop, and by Claude Code to read per-turn usage out of the session transcript at Stop — see §6.4). Agents that speak Claude Code's stdin hook shape — Codex, Gemini CLI and Copilot CLI all do — are configuration objects over a shared factory rather than separate implementations.

Local queue: SQLite database at `~/.claude-telemetry/queue.db`. Survives crashes, machine reboots, and offline periods.

**Hook latency budget:** Telemetry hooks must add **<10ms** to any tool call on the hot path. Anything slower gets ripped out by power users. The hook writes to local queue and exits; the flusher is a separate background process.

### 6.3 Hook Payload Contract

```json
{
  "schema_version": 1,
  "event_id": "01939f6c-...-uuidv7",
  "session_id": "claude-code-session-uuid",
  "user_id_claim": "github:jorgef",
  "ts": "2026-05-16T14:32:11.482Z",
  "event_type": "PostToolUse",
  "turn_number": 17,
  "parent_event_id": "01939f6c-...-turn-17-stop",

  "client": {
    "claude_code_version": "1.x.y",
    "os": "darwin",
    "hostname_hash": "sha256:..."
  },

  "session_context": {
    "cwd": "/Users/jorge/code/foo",
    "git": {
      "remote_url": "git@github.com:s1/foo.git",
      "owner": "s1",
      "repo": "foo",
      "branch": "feat/JIRA-1234",
      "commit": "abc1234",
      "is_dirty": true,
      "pr_number": 4421
    },
    "mode": "normal",
    "is_resume": false
  },

  "tool": {
    "name": "Edit",
    "category": "fs_write",
    "input_hash": "sha256:...",
    "input_bytes": 1842,
    "output_bytes": 312,
    "duration_ms": 287,
    "exit_status": 0,
    "was_denied": false,
    "was_interrupted": false,
    "mcp_server": null,
    "mcp_tool": null,
    "subagent_type": null,
    "skill": null,
    "slash_command": null
  },

  "llm": {
    "model": "claude-sonnet-4-6",
    "input_tokens": 142,
    "output_tokens": 318,
    "cache_read_tokens": 18420,
    "cache_creation_tokens": 0,
    "cost_usd": 0.00487
  },

  "metadata": {}
}
```

Send only relevant blocks per event type. `tool` is null on `UserPromptSubmit`. `llm` is null on `SessionStart`. Empty blocks omitted.

**Turn linkage** (P14-003, completed for live sessions by P14-006). `turn_number` is 1-based, increases monotonically within a `session_id`, and increments once per assistant turn; it is carried by the turn's `Stop` — which is where that turn's `llm` block lives — and by the tool events for the calls that turn issued. `parent_event_id` on a tool event is the `event_id` of its turn's `Stop`; it is NULL on the `Stop` itself and on non-tool events. Both are optional: an agent that cannot derive a turn correctly emits neither, and NULL means "not attributed", never zero. There is **one** definition of both, whether a row was captured live, joined server-side, or imported. See §6.4 for which paths populate them and how.

### 6.4 Transcript Shipping

At `Stop` and on a 10-minute heartbeat for long-running sessions:

1. Read `~/.claude/projects/<encoded>/<session_id>.jsonl`
2. Run redaction pass (see §9)
3. Compress with **zstd**, streaming the redacted lines through `node:zlib`'s `createZstdCompress` so the full uncompressed transcript never sits in memory. The ingest service still accepts **gzip** for backward compatibility, but it always decompresses, re-redacts as defense-in-depth, and re-compresses to zstd for storage — so the stored object is always `.jsonl.zst` regardless of the upload encoding
4. `POST /v1/transcripts/{session_id}` with `Content-Range` for chunked / resumable upload
5. Server writes to MinIO/S3 at `transcripts/{yyyy}/{mm}/{dd}/{user_id}/{session_id}.jsonl.zst`
6. On final chunk, update `sessions.transcript_*` columns

**The transcript is also read locally, at Stop, for token usage (P14-003).** Claude Code's hook payload carries none — on any hook — so until P14-003 the only producer of an `llm` block for `CLAUDE_CODE` was the `import` subcommand, and every live-captured session recorded `$0` across every cost surface in the product. The Stop payload hands over `transcript_path`, each `assistant` entry in that JSONL carries `message.usage`, and `mapBatch` folds one Stop event per assistant turn out of the entries appended since the last Stop.

Two properties of that read are load-bearing:

- **It is incremental.** Stop fires once per response cycle, so re-reading the whole transcript each time is O(n²) over a session. A per-session `{ path, offset, turns }` cursor under `agentStateDir('claude-code')` keeps each Stop's cost flat in session length. The *first* Stop of a session reads from the top on purpose, so the turn ordinal is counted from entry one.
- **Its event ids and timestamps are derived from the transcript entry**, identically to what `import` synthesizes for the same turn (`apps/hook/src/lib/claude-turns.ts` is the single definition). Both paths can produce events for the same session, so this is what lets ingest's `ON CONFLICT (event_id, ts) DO NOTHING` dedupe them — without it, a session captured live and later imported would be billed twice, permanently, since `sessions.total_cost_usd` accumulates and is never recomputed.

`turn_number` and `parent_event_id` (§6.3) are populated from the same read. **On the live path the hook can only put them on the Stop**: `PreToolUse`/`PostToolUse` hooks are separate processes that fire *before* their turn's Stop exists, and Claude Code's Stop hook fires per response cycle rather than per assistant turn, so no correct live turn number is derivable in the hook without transcript I/O on the hottest path.

**A server-side join closes that for live tool rows (P14-006), on a natural key rather than a heuristic.** Claude Code's tool-hook payloads carry `tool_use_id`, and the transcript repeats the same id on the `tool_use` block of the turn that issued the call — so the hook promotes that id onto the tool event (`events.tool_use_id`), and the Stop it already derives from the transcript also lists the ids that turn issued (`metadata.tool_use_ids`). Ingest's `link-turn-events` job (§6.5) joins the two on `(session_id, tool_use_id)` over settled sessions and writes exactly the linkage the import path writes inline, so live and imported sessions mean the same thing. Nothing consults a clock: a `ts`-nearest-Stop heuristic was considered three times and rejected each time, because parallel tool calls, the cycle/turn cadence mismatch and clock skew each put a call in the wrong turn's divisor and the symptom is a plausible dollar figure on the wrong tool. A call whose issuing turn is absent — a truncated transcript, a hook older than P14-006, another agent — stays NULL, which downstream reads as "not attributed" rather than `$0`.

Every failure mode of the read — missing, truncated, locked or malformed transcript — degrades to a usage-less Stop. The always-exit-0 rule (§6.2) is not weakened by it.

### 6.5 Ingest Scheduler Jobs

`apps/ingest` runs scheduled background jobs from `apps/ingest/src/jobs/scheduler.ts`. Nightly jobs are configured in the `job_config` table and can be enabled, disabled, rescheduled, or manually triggered from `/admin/jobs`; fixed-cadence jobs run from in-process intervals.

| Job | Schedule | Purpose |
|---|---|---|
| `sweep-abandoned` | every 10 min | Marks stale ACTIVE sessions as ABANDONED (no event for >30min) |
| `sweep-scratch` | hourly | Cleans up orphaned transcript chunk scratch files |
| `sync-teams` | hourly | GitHub team membership sync for all orgs |
| `sync-jira` | every 6h when `JIRA_BASE_URL` + `JIRA_API_TOKEN` are set | Resolves every `jira_key` on PRs/sessions (plus linked issues) into `jira_issues` rows (summary, type, status, epic, project, story points, created date, and — when `JIRA_VALUE_FIELD` is set — per-issue `business_value`) and snapshots issue links into `jira_issue_links` — the basis for defect attribution on `/org/quality` and the true business-value join on `/org/roi` |
| `run-deletions` | every 6h | Processes queued GDPR `DeletionRequest` rows |
| `sweep-retention` | configurable, default 02:00 UTC | Deletes transcripts (S3 + `transcript_s3_key`) past the global or per-team retention window |
| `index-transcripts` | configurable, default 03:30 UTC | Populates `transcript_index` for Postgres FTS |
| `compute-effectiveness` | configurable, default 05:00 UTC | Computes `friction_score` + `shape_label` on sessions |
| `evaluate-alerts` | configurable, default 01:00 UTC | Evaluates alert rules; fires/resolves `AlertEvent` rows and sends configured notifications |
| `reconcile-cost` | daily when `BILLING_RECONCILIATION_ENABLED=true` | Gated cost reconciliation: compares client-computed `SUM(events.cost_usd)` against the vendor-billed cost for the previous calendar month, per `agent_type`, emitting delta/drift gauges. Vendor cost comes from `AnthropicBillingSource` (Admin **Cost Report API**, `GET /v1/organizations/cost_report`) when `ANTHROPIC_ADMIN_KEY` is set — only `CLAUDE_CODE` has an Anthropic bill; other agents record no drift. Falls back to a null source (no comparison) when the key is unset |
| `compute-effectiveness-backfill` | operator-triggered only | One-shot historical effectiveness backfill, intentionally not exposed through `/admin/jobs` |
| `rescore-effectiveness` | operator-triggered only | Re-scores every session whose `scores` rows are behind the **current** scorer version (P13-001). Selects on the absence of a row at that version rather than `shape_label IS NULL`, which is the marker that made re-scoring impossible — bump `FRICTION_VERSION` or `SESSION_SHAPE_VERSION`, trigger once, prior-version rows preserved |
| `compute-trajectory-scores` | configurable, default 05:30 UTC | Deterministic, content-free trajectory scorers over the events hypertable (P13-003) — retry loops, edit thrash, redundant re-reads, denial→retry→success chains, tests-run-before-merge, step efficiency against a per-shape baseline derived from the data. Writes `scores` rows only; reads no transcript |
| `rescore-trajectory` | operator-triggered only | The trajectory equivalent of `rescore-effectiveness`: re-scores sessions whose rows are behind the current trajectory scorer versions |
| `compute-subject-scores` | configurable, default 06:00 UTC | Skill and MCP-server effectiveness (P13-004) — invocation volume against downstream friction, tool-error rate, and PR outcome, written as `scores` rows keyed on `SKILL` / `MCP_SERVER` subjects |
| `judge-sessions` | configurable, **disabled by default** | Opt-in LLM-as-judge over consented transcripts (P13-009). Sampled and batched; gated by two independent guards (the owner's `allow_judge_analysis` consent **and** an own-sessions-only code constant), audit-logged before every read, rationales stored by reference. Enabling it is an operator decision taken in `/admin/jobs`, not a consequence of deploying |
| `backfill-redaction` | operator-triggered via `/admin/jobs` | Backfills `sessions.redaction_flags` for transcripts archived before the column existed, by scanning stored (already-redacted) transcript text for `[REDACTED:<class>]` markers; drains the whole backlog in one run via a keyset walk (memory-bounded per page) |
| `reprice-events` / `reprice-events-apply` | operator-triggered via `/admin/jobs` | Recomputes historical `events.cost_usd` from the stored token counts against the **current** price tables, then the `sessions` / `pr_rollups` totals and the two cost continuous aggregates that derive from it. Two names, one job: the bare name only reports what would change, `-apply` writes. Repricing is all-or-nothing — a windowed run would leave sessions straddling the boundary summed from a mix of old and new rates |

### 6.6 Identity Trust Model

`user_id_claim` from the hook is informational. **The authoritative user identity comes from the auth token on the ingest request**, not from the payload. If a hook claims to be `alice` but the token belongs to `bob`, the events are stored as `bob` and a `suspicious_identity_claim` flag is logged.

### 6.7 Cost Source of Truth

Cost is computed from token counts × a **versioned, per-agent price table**, keyed on `(agent_type, model)`. Ingest is where the computation happens: adapters emit `cost_usd: 0` and ingest recomputes on receipt, so a price correction lands by editing a JSON file and restarting ingest — no hook redeploy, and no trust placed in a number the client sent. The table is also served at `GET /v1/price-table?agent=` for `/admin/price-tables` and the `/org/models` routing estimate.

The provider decides what the four rates mean. Anthropic reports four disjoint token counts; OpenAI and Google report one inclusive prompt total with the cached tokens *inside* it. The adapter normalizes to disjoint counts before emitting, because that is where the provider's semantics are known and ingest's cost function stays agent-neutral — otherwise the cached tokens bill twice, once at the cache rate and again at full input.

A model absent from its agent's table bills `$0` and increments `unknown_model_events_total`; the `unknown_model_surge` alert names the offending models, and `/admin/price-tables` lists them with their traffic — that, not a guess, is the signal to extend the table.

Correcting a table only affects events ingested *after* the fix; `cost_usd` is written once. The operator-triggered `reprice-events` job recomputes history from the stored token counts (§6.5), and is the only supported way to do so — hand-written UPDATEs leave the session totals, PR rollups and continuous aggregates disagreeing with the events they summarize.

(Alternative considered: pull billed amounts from Anthropic's admin API. Adds a dependency; scaffolded behind a flag in P8, see §13 Q4.)

---

## 7. GitHub Integration

GitHub does several jobs in this design.

### 7.1 As Identity Provider

- **GitHub OAuth App** for user login to the dashboard
- `github_login` is the canonical user identifier; email is secondary
- Team membership pulled from GitHub teams via API on login + nightly sync job
- Team scope in the UI maps 1:1 to GitHub teams (no separate team model to maintain)

### 7.2 As Work-Unit Source (GitHub App, separate from OAuth App)

- Webhook receiver for `pull_request` events: `opened`, `synchronize`, `closed` (with `merged=true`)
- On open/synchronize: upsert the PR and link sessions by branch name (open-PR dashboards see links before merge)
- On merge: finalize PR rollup, compute final cost, link contributing sessions (by branch name and by commit SHA), snapshot lines changed
- Webhook for `pull_request_review`: per-review rows in `pr_reviews`; `review_count` maintained from submitted reviews
- Webhook for `check_run`: per-run outcomes in `pr_check_runs`; the P5-005 failure counter is derived from those rows (idempotent under redeliveries)
- Webhook for `push` on default branch: commit→sessions correlation via author + timestamp window (grace configurable via `COMMIT_LINK_GRACE_HOURS`, default 24h) into `session_commit_links`
- API enrichment: PR title, labels, reviewers, time-to-merge, review comment count

### 7.3 As Context Source for Sessions

At SessionStart, the hook captures (client-side):

- Repo (from `git remote get-url origin`)
- Branch (`git branch --show-current`)
- Commit SHA, dirty state
- Open PR for the branch, if any (`gh pr view --json number 2>/dev/null`)

This gives a session → PR link immediately, no waiting for webhook reconciliation.

### 7.4 As Reporting Destination

A bot posts at PR merge time:

> 🤖 **Claude Code summary for this PR**
> • 4 sessions across 2 contributors
> • ~$3.40 total, 87 tool calls
> • Primary tools: Edit (42), Bash (18), Read (15)
> • Skills used: docx, pdf-reading
> • Time-to-merge: 18h

Opt-in per repo via a `.claude-telemetry.yml` file at the repo root. Devs love these comments and they make the tool's value visible without forcing dashboard visits.

### 7.5 Two GitHub App Surfaces — Why Both

- **OAuth App** for user login: acts as the authenticated human user, gets `read:user`, `read:org` scopes.
- **GitHub App** for webhooks + PR bot: per-org/per-repo installation, better permission scoping, uses installation tokens. Avoids acting "as a user" for automated comments.

Don't merge these. Separation of concerns matters for permission audits.

---

## 8. Access Control & Privacy

### 8.1 Roles

| Role               | Sees                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `member`           | Own sessions only. Always.                                                 |
| `team_lead`        | Own + team's sessions (metadata always; transcripts only if user opted in) |
| `org_admin`        | Everything, with audit-logged transcript views                             |
| `viewer_aggregate` | Org-wide aggregates only; no individual sessions or transcripts            |
| `investigator`     | No standing individual access. Can request time-boxed grants (§8.4) for sampled session investigation; each grant is org-admin approved, scoped, and expires. |

`viewer_aggregate` is the audience-A role: finance/leadership can see spend without the panopticon. `investigator` is the audience-B research role (Phase 9).

### 8.2 Per-User Visibility Settings

| Setting                       | Default | What it controls                                                            |
| ----------------------------- | ------- | --------------------------------------------------------------------------- |
| `share_metadata_with_team`    | ON      | Team lead can see your session metadata (cost, tool counts, repo, duration) |
| `share_metadata_with_org`     | ON      | You contribute to org-wide aggregates                                       |
| `share_transcripts_with_team` | **OFF** | Team lead can read transcript content of your sessions                      |
| `share_transcripts_with_org`  | **OFF** | Org admin can read transcript content without justification                 |

**Defaults are conservative.** Users can opt in to more sharing; they can never be opted in _up_ by an admin. Defaults are the political fault line of the project at 200 devs — get them wrong and the tool dies.

### 8.3 Audit Log on Privileged Access

Every team_lead or org_admin view of someone else's session writes an `audit_log` row. The affected user can see "Bob looked at your session from Tuesday" inside their "My Agents" page.

This sounds paranoid; it is the difference between adoption and sabotage. **Non-negotiable.**

### 8.4 Investigation Paths

Even with `share_transcripts_with_org=false`, another user's session/transcript can be reached through one of two audited paths (`resolveOrgSessionAccess` in `apps/web/src/lib/roles.ts` is the single decision shared by the org session-detail page, transcript page, and transcript API route):

- **Org admin — justification at view (standing).** An org admin can request transcript access for a specific session by providing a `justification` (e.g., "security incident #1234"). This is logged loudly and visibly; the user sees the access in their own audit feed.
- **Investigator — time-boxed grant (no standing access).** An `investigator` (Audience B) has *no* standing individual reach. They request an access grant for a specific session or a user's sessions, citing justification; an org admin approves it; the grant is time-boxed and expires. While the grant is active (`hasActiveGrant`), the investigator views the in-scope session and transcript with no per-view justification — the approved grant is itself the authorization. When it expires, access reverts to aggregate-only with no code change. Every view is still audited (§8.3).

Individual session *search/discovery* stays org-admin-only; investigators reach sessions by a known URL plus an active grant (sampled-session discovery UX is a follow-up).

---

## 9. Redaction Strategy (v1)

Transcripts can contain anything — prompts with file contents, accidentally-pasted API keys, customer data. At 200 devs this is a compliance concern, not a nice-to-have.

### 9.1 Day-One Redaction Pass

Before upload to object storage, the client (yes, client-side, because we don't want raw secrets touching the server) runs a regex sweep for:

- AWS access keys (`AKIA[0-9A-Z]{16}`)
- AWS secret keys (40-char base64)
- GitHub PATs (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` prefixes)
- JWT-like strings (three base64 segments separated by `.`)
- Slack tokens (`xox[abp]-`)
- Generic `.env`-style lines (`KEY=value` where key matches `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`)
- Private key headers (`-----BEGIN ... PRIVATE KEY-----`)
- URL-embedded credentials (`scheme://user:secret@host` — the userinfo is scrubbed, scheme/host/path preserved; runs after the token rules so a known token in the password keeps its own class)
- Email addresses (PII; regex with a required dotted TLD)

Matches are replaced with `[REDACTED:type]` placeholders (square brackets, not angle brackets — the markers must survive being rendered as HTML in the transcript-search excerpt view without being mistaken for a tag). The transcript is tagged `transcript_redacted=true` with a list of redaction classes encountered.

### 9.2 Deferred Redaction Work

- ML-based PII detection (names, phone numbers in customer data). Regex email redaction now ships (§9.1); ML-grade name/phone detection remains deferred.
- Repo-specific redaction policies (e.g., "this repo touches PHI, scrub harder")
- Per-user opt-in to stronger redaction tiers
- Re-redaction sweeps when new patterns are added

### 9.3 What is Never Stored Server-Side

- Raw tool inputs and outputs (only hashes and sizes go to `events`)
- Raw prompts in the events table (full prompts only in the transcript blob, post-redaction)
- Assistant prose in the events table — same rule, other direction (P14-008)
- Unredacted secrets that match day-one patterns

**`events.metadata` is provenance, not content, and that is now enforced rather than
assumed.** Every adapter copies payload keys it did not model structurally into
`metadata` so an unmodelled field is preserved rather than lost. That passthrough was
*unknown ⇒ verbatim*, which held only for as long as no vendor added a prose field —
and they did: Claude Code's `Stop` / `SubagentStop` grew `last_assistant_message`
("Text content of the last assistant message before stopping"), and Copilot CLI's
`userPromptSubmitted` carries the user's whole `prompt`. Both landed in Postgres
unredacted, because `packages/redaction` runs on the transcript path and nothing runs
on this column. The rule is now *unknown ⇒ bounded scalar*
(`packages/schemas/src/metadata-safety.ts`): a shared agent-neutral list of
content-bearing key names is refused outright, and so is any value that is not a JSON
scalar or is a string longer than 200 characters — the shape half being the part that
does not need to know the name of a field nobody has invented yet. Derived values the
platform computes (`slash_command`, `notification_kind`, `tool_use_ids`, `source`) are
added after the filter and are unaffected. Ingest applies the name half again on
receipt, because the hook is a binary developers upgrade on their own schedule.

---

## 10. Metrics Captured

### 10.1 Captured at v1 (Schema-Locked)

**Per event (hook firehose):**

- Event type, timestamps, durations, turn number, parent event ID
- Tool name, category, input/output sizes, exit status, duration
- Permission events: prompted, denied, interrupted
- MCP server + tool (separate dimension)
- Subagent type (when Task tool used with subagent)
- Skill name + path (when skill loaded)
- Slash command name (when invoked)
- Model per turn (not just per session)
- Input/output/cache_read/cache_creation tokens
- Cost (computed ingest-side from the versioned per-agent price table — §6.7)
- Mode (normal / plan / accept_edits)

**Per session:**

- Lifecycle: started, ended, last activity, status, end reason
- Resume / chaining: is_resume, resumed_from_session_id
- Compaction count, clear count
- Client environment: Claude Code version, OS, hashed hostname, cwd
- Git context: repo, branch, commit, dirty, PR number
- Incremental aggregates (tokens, cost, tool calls, errors, permission events, model turns)
- Transcript pointer

**Per PR rollup:**

- Contributing sessions and users
- Total cost, tokens, tool calls, errors
- Lines added/removed, files changed (from GitHub at merge)
- Reviewers, labels, time-to-merge

### 10.2 Computed Lazily (on Read)

- Session shape clusters (exploratory / implementation / debugging / planning based on tool histograms)
- Cost-per-accepted-edit, cost-per-LOC
- Friction scores (composite: retries + denials + interrupts + abandonment)
- Cache hit ratios (surfaced as **cache efficiency** = `cache_read_tokens / (input_tokens + cache_read_tokens)` on team and org stat cards)
- **Period-over-period deltas**: for any date range window *W*, the prior period of equal length is queried and the percentage change is shown alongside each stat card — requires no additional stored columns, computed at read time from the same aggregation query run twice
- Time-of-day / day-of-week patterns
- Wasted spend proxies (sessions ending in `/clear` < N min, no edits, abandoned)
- Files-read-but-never-edited (exploration vs action ratio)
- Resume vs fresh-start ratio per user

### 10.3 Captured Now, Surfaced Later

Some signals are cheap to capture and expensive to backfill — captured day one even if no dashboard surfaces them yet:

- Per-turn model (enables model-mix analysis later)
- Cache token breakdown (enables context-management analysis)
- Subagent and MCP dimensions as their own fields (avoids schema migration when those features grow)
- Slash command tracking (leading indicator of power-user adoption)
- Hook execution self-timing (do our hooks slow people down?)

### 10.3a Human-in-the-loop signals (added post-Phase 9)

Following the HITL assessment (`docs/research/2026-06-30-human-in-the-loop-assessment.md`), the platform now captures and surfaces the human↔agent oversight signal it was previously discarding:

- **Permission/autonomy mode** — the agent's `permission_mode` (`normal`/`plan`/`accept_edits`/`auto`/`dont_ask`/`bypass`) is read from the hook payload (was hardcoded `normal`), stored per-event (`events.mode`) and as a representative least-supervised mode per session (`sessions.mode`).
- **Notification classification** — `Notification` events are classified into `events.notification_kind` (`permission`/`idle`/`elicitation`/`auth`/`other`); `sessions.notification_count` counts them and `sessions.permission_prompt_count` is finally populated from permission notifications.
- **Human response latency** — `sessions.total_response_ms` / `response_sample_count`, derived nightly from the gap between a blocking notification and the next event.
- **Surfaces** — an "Oversight & Autonomy" panel + rubber-stamp/over-trust detector on `/me`, `/team/[slug]`, and `/org/governance`; a mode search facet; a `/org/governance` oversight-posture + AI-authored-code-provenance report; per-session human feedback (`session_feedback`).
- **Governance** — alert acknowledge + rule silence/snooze; an `autonomy_surge` alert rule (oversight erosion). Consistent with the observe-only architecture: nothing intercepts a live tool call.

### 10.4 Explicitly Deferred to v2+

- Bug correlation (Jira/Linear → PR → session)
- IDE telemetry joins (VSCode/Cursor)
- Lint/test correlation via GitHub Checks API
- Revert detection through git history scanning
- Pre/post Claude-adoption longitudinal per-dev (requires baseline data many orgs don't have)
- Org-wide active-user / onboarding-curve / drop-off analyses (compute available; UI not in MVP)

### 10.5 Metrics Explicitly Avoided

- **Lines of code generated.** Rewards verbosity, punishes refactoring. Standard AI-tooling vanity metric.
- **"% of code written by AI."** Unmeasurable rigorously. Will end up in a board deck and misinform decisions.

If leadership asks for either: substitute "merged commits touched by Claude Code" — at least requires the code to survive review.

### 10.6 The Effectiveness Caveat

Cost-per-feature is **directionally useful and precisely misleading.** A $40 session that unblocks a senior dev for two days is wildly cheaper than a $5 session that produces code someone rewrites. Dashboards must frame cost alongside outcome signals (PR merged? reverted? bug filed within 30 days?) or the tool gets optimized for the wrong thing — devs avoiding Claude on hard problems because it "costs more."

This is a presentation discipline, not a data model decision. Worth re-asserting in dashboard reviews.

---

## 11. Technology Decisions

### 11.1 Timescale over ClickHouse (v1)

**Choice:** Postgres + TimescaleDB hypertable for the events firehose.

**Rationale:**

- At 200 devs × hundreds of tool calls/day, volume is millions of rows/month — well within Timescale's comfort zone
- One fewer system to operate (Jorge's stack already leans Postgres-heavy)
- Same SQL surface as the dimensions database; easier joins for the UI
- Switching to ClickHouse later is a straightforward migration if dashboard queries start timing out

**Re-evaluation trigger:** Aggregation queries on the events table consistently exceed 2s on production hardware, or storage growth makes Postgres maintenance painful.

### 11.2 Bun for the Hook Binary

**Choice:** Single static binary compiled with `bun build --compile`, distributed via existing dev-machine config.

**Rationale:**

- Single static binary, trivial to ship — Bun's `--compile` flag bundles the runtime
- Cross-compile for darwin/arm64, darwin/amd64, linux/amd64, linux/arm64
- Entire codebase is TypeScript; no second language to maintain
- `Bun.zstd*` APIs available natively — no userland zstd package needed
- SQLite support built into Bun — no CGO linking required

**Alternative considered:** Bash hooks. Dead simple but no batching, no local queue, no retry. Doesn't scale to 200 devs without a complementary daemon anyway — so just build the daemon.

**Alternative considered:** Go binary. Would work well; rejected to keep the codebase in one language (TypeScript everywhere).

### 11.3 MinIO for Transcript Blobs

**Choice:** MinIO for local dev and homelab prod (S3-compatible, self-hosted).

**Rationale:**

- S3-compatible API — swap to any S3-compatible cloud store (Backblaze B2, AWS S3, Tigris) without code changes
- Self-hostable on existing homelab hardware
- Lifecycle rules support easy 1-year retention enforcement
- Local dev and prod use the same code path; no special-casing

**Alternative considered:** Backblaze B2. Viable for cloud prod since it's S3-compatible and cost-effective; can be adopted later as a prod overlay without changing application code.

### 11.4 Next.js for the UI

**Choice:** Next.js + React, server components for the read-heavy dashboard pages.

**Rationale:**

- Matches Jorge's existing stack
- Good Postgres integration via direct queries or a thin ORM
- Easy to deploy alongside the API service

**Alternative considered:** Grafana for the dashboard. Faster to start, but no "My Agents" experience, no transcript viewer, no opt-in/opt-out UI. Use Grafana as a complement for ops dashboards, not as the primary user-facing surface.

### 11.5 GitHub App vs OAuth App

**Choice:** Both, separately scoped (see §7.5).

### 11.6 Cost Computation: Server-Side, Versioned Per-Agent Table

**Choice:** Ingest computes cost from token counts × a versioned per-agent price table, keyed on `(agent_type, model)`. The table ships as JSON in `apps/ingest/src/data/` and is served at `GET /v1/price-table?agent=` for the admin and routing surfaces.

**Rationale:**

- A price change is a JSON edit plus an ingest restart — no hook redeploy, and no re-shipping binaries to every developer machine
- Client-reported cost is an input, never a fact; recomputing server-side means a stale or tampered hook cannot move the numbers
- Per-agent keying stops two vendors' same-named models from colliding
- Ground truth (Anthropic admin API) is a heavier dependency; scaffolded behind a flag rather than adopted (§13 Q4)

**Known limits, all deliberate:**

- One rate per model. Google's prompt-size tiers (`gemini-2.5-pro` above 200k) and Anthropic's 1-hour cache write are not expressible; the tables use the common tier and say so in their `_comment`.
- **Two provenances.** The single-vendor tables (`claude_code`, `codex`, `gemini_cli`) are transcribed by hand from that vendor's pricing page, which carries promotional windows and tiering a catalog flattens away. The provider-agnostic ones (`pi`, `omp`, `opencode`) are generated from the models.dev catalog — the same catalog opencode builds its own model list from, so the keys are the names the adapter reports — via `bun run gen:price-tables`. A test binds the two: where both name a model, they must agree.
- **Alias tags are deliberately unpriced.** `gemini-flash-latest` and friends are repointed at a new model without the name changing, so a rate pinned to one would silently misprice from the day it moves. They bill `$0` and report themselves, which is the honest failure.
- **Two denominators, since P14-015.** A table may also carry `request_pricing` — per-model request multipliers, a per-seat monthly allowance and an overage rate — for agents billed per *request* against a seat allowance rather than per token. It is optional and additive: `computeCostUsd` does not read it, so a token-priced table is unaffected, and a request-priced table needs no token rates. **Nothing derives a dollar figure from it**, deliberately: which denominator a seat bills on is a property of its *plan*, and remaining allowance is monthly and per-seat — neither is observable from telemetry, so any total would be an *imputed* marginal cost at the overage rate, not billed spend. It is rendered on `/admin/price-tables` as reference.
- **GitHub Copilot is token-priced, and its table is no longer empty.** It was, on the finding that "Copilot does not bill tokens at all" — true until 2026-06-01, when GitHub replaced premium requests with token-metered *AI credits* (1 credit = $0.01) and began publishing a per-model per-Mtok rate. `copilot.v2` is transcribed from that page, so the rates are GitHub's own resale prices, not the underlying vendors' direct ones (which differ). `request_pricing` on the same table records what survives of the old model: it now applies only to Pro/Pro+ subscribers on a pre-existing annual plan.
- **Copilot spend still reads unknown, and that is a capture gap, not a pricing one.** No Copilot CLI hook payload carries a token count *or a model* (P14-007, re-verified 2026-08-27), so no Copilot event has ever reached `computeCostUsd` — which also means Copilot models have never appeared in `unknown_model_events_total` or on the unpriced-models surface, both of which key on a non-null `model`. The event→request mapping GitHub documents is exact ("Each prompt to Copilot CLI uses one premium request"; "only the prompts you send count … actions Copilot takes autonomously … such as tool calls, do not"), so one `UserPromptSubmit` is one request; the *multiplier* is what is undetermined, spanning 0.25× to 57× with no documented CLI default. A request count is therefore exact and a request cost is not, and `/org/agents` shows the count with a dash for cost rather than a confident zero.

### 11.7 Platform Self-Observability: stdout Logs + Prometheus (v1)

**Choice:** The platform observes *itself* with structured pino logs to stdout plus Prometheus metrics (`prom-client`, scraped into the bundled Grafana). There is **no centralized error aggregation** (Sentry / OpenTelemetry) for the app's own operational errors in v1.

Concretely:

- All three apps log structured JSON via pino, with level set by `LOG_LEVEL`. The two Hono services (`apps/ingest`, `apps/github-app`) additionally correlate each log line with a per-request `x-request-id` and have a catch-all `onError` handler that logs unhandled throws with the request id before returning a 500. `apps/web` (Next.js) has no equivalent Hono-style request-id correlation or `onError` handler — it relies on Next's error boundary and route-handler-level handling.
- The three HTTP services expose `/metrics`; operational dashboards live in the bundled Grafana/Prometheus stack.
- Container logs (stdout) are the aggregation surface — collected by whatever the operator's Docker/host logging driver provides.

**Rationale:**

- This is a self-hosted, single-operator homelab deployment (§11.3). `docker compose logs` + Grafana is a proportionate operational surface; a hosted error-tracking SaaS or an OTLP collector + backend is more infrastructure than the v1 audience needs.
- Staying pino-native keeps one logging model across services and avoids coupling the app to a specific tracing/error vendor before the deployment story demands it.

**Deferred — recommended path when needed:** when centralized error aggregation becomes worthwhile (multi-node deployment, on-call rotation, or error-rate SLOs), add an env-gated log/trace exporter rather than scattering vendor SDK calls. The Grafana-native fit is an OTLP exporter (pino → OpenTelemetry logs, plus error spans) shipping to Loki/Tempo alongside the existing Prometheus metrics, wired once per service and off unless an OTLP endpoint is configured.

**Re-evaluation trigger:** the deployment grows beyond a single host/operator, or diagnosing a production incident from stdout logs alone becomes the bottleneck.

---

## 12. MVP Scope & Phasing

Resist the urge to build all of it. The MVP that proves value:

### 12.1 Phase 1 — Spine + Self-Service ("My Agents")

1. Ingest API + Timescale events + Postgres sessions + MinIO/S3 transcript upload
2. GitHub OAuth login + nightly team sync
3. Hook binary (Bun-compiled), distributed via internal dotfiles / MDM
4. Redaction v1 (regex pass)
5. "My Agents" page — every dev gets full access to their own data
6. Privacy controls UI (visibility policy editor)
7. Audit log (writes only; no UI yet beyond own audit feed)

**Success criteria:** Devs visit "My Agents" voluntarily and find it useful. No team or org views exist yet.

### 12.2 Phase 2 — PR Loop

8. GitHub App for webhooks + PR enrichment
9. PR rollup compute on session end + PR merge
10. PR bot — post merge summary comments (opt-in via `.claude-telemetry.yml`)
11. Self-service PR list with cost-per-PR for the dev's own PRs

**Success criteria:** PR bot comments show up on real PRs and get reactions. Devs share screenshots in chat.

### 12.3 Phase 3 — Team Views

12. Team roster with aggregate per-dev metrics
13. Team trends dashboard (cost, tool mix, skill adoption)
14. Team-scoped PR rollups
15. Drill into individual sessions (only when user opted in)
16. Audit-log feed in "My Agents" — "who looked at me"

*P3 additions (landed 2026-06-25):*

- Date range selector (7d/30d/90d) on the team dashboard — all stat cards and charts scope to the chosen window
- Period-over-period delta indicators on stat cards — compare current window to the prior period of equal length
- Team PR rollup tab (`/team/[slug]/prs`) — merged PRs with per-PR cost, session count, and time-to-merge
- Cache efficiency metric — `cache_read_tokens / (input_tokens + cache_read_tokens)` surfaced as a stat card; teams optimizing prompt structure see immediate feedback

**Success criteria:** Team leads use weekly; no privacy-related fires.

### 12.4 Phase 4 — Org Views & Search

17. Org-wide dashboards (cost by team/repo/model, adoption metrics)
18. Faceted search (visibility-scoped)
19. Free-text transcript search (Postgres FTS, swappable for Meilisearch)
20. Aggregate-only viewer role for leadership
21. Anomaly surface (spend spikes, high error rates)

*P4 additions (landed 2026-06-25):*

- Date range selector (7d/30d/90d) on the org dashboard — same UX as the team dashboard, scopes all org-level stat cards and charts
- Period-over-period delta indicators on org stat cards — compare current window to prior period
- Org adoption funnel widget — active users → session starters → PR authors, showing week-over-week conversion at each stage
- Per-team model governance table (org admin only) — shows which models each team has used in the selected window, flagging any models outside the approved set; gated behind `OrgRole.ORG_ADMIN`

*Additional pages shipped beyond the original P4 scope:*

- `/install` — hook binary download page; lists four platform targets with download links and install instructions
- `/org/benchmarks` — per-team benchmark comparison across the org
- `/org/delivery` — PR delivery stats: time-to-merge, weekly trend, top repos
- `/org/tools` — org-level tool usage breakdown
- `/org/security` — AI-agent data-flow & access posture: tool-category exposure, per-repo exec/network/write exposure, external MCP egress inventory, largest data movements (`tool_output_bytes`), and privileged-access audit summary. Aggregate, visibility-scoped
- `/org/knowledge` — aggregate transcript topic clustering (keyword taxonomy over the FTS index) with small-n suppression; no individual content
- `/admin/adapters` — per-agent adapter status (last-seen session, 7d session count) + client CLI/agent version mix
- `/admin/jobs` — background job config (enable/disable individual scheduler jobs, trigger on demand)
- `/admin/price-tables` — manage per-agent/per-model price tables

The `/org/dashboard` also carries a **spend forecast** (trailing-7d run-rate + month-to-date projections, per-team run-rate, and a comparison against a configured `budget_threshold` alert rule) and a **cohort friction divergence** table (median friction by first-seen-month cohort, small-n suppressed). Session detail and `/me/insights` now surface the previously-captured-but-unrendered context-pressure (`compaction_count`/`clear_count`), continuity (`is_resume`), notification-kind, tool-byte-volume, `pr_review_decision`, `cost_per_loc`, and Jira `story_points` (cost-per-story-point on `/org/roi`) signals, plus a per-user **weekly shape-shift trend**. `/org/models` carries **routing recommendations** whose per-model saving fraction is derived from the ingest price table (`GET /v1/price-table`, falling back to a flat heuristic when `INGEST_URL` is unset), paired with a `routing_waste` **alert rule** (premium-model spend on retrieval-only categories over a threshold) and a per-team **routing accountability** table (premium spend on retrieval-only work, visibility-scoped, team-level only) — the observe-only substitute for hook-side routing enforcement (`§10.3a`). `/org/security` adds **secret-exposure by redaction class** (`sessions.redaction_flags`); an operator-triggered `backfill-redaction` job populates that column for transcripts archived before it existed by scanning stored (already-redacted) transcript text for `[REDACTED:<class>]` markers. `/org/roi` adds a **business-value** section: when `JIRA_VALUE_FIELD` is set, the `sync-jira` job pulls each ticket's real per-issue value into `jira_issues.business_value` and the section prefers that true external join, falling back to a flat `VALUE_PER_STORY_POINT` proxy (delivered story-points × the configured rate) when no synced ticket carries a value. The org cost/model/tool rollups read from the `daily_cost_by_user`, `daily_cost_by_model`, and `daily_tool_usage` continuous aggregates — all three carry `user_id` so each is visibility-scoped like the raw-events queries it replaced.

**Success criteria:** Quarterly leadership readout uses this instead of ad-hoc spreadsheets.

### 12.5 Phase 5 — Effectiveness Signals ✓ done

22. Friction score composite metric (`friction_score` stored on sessions; computed by `compute-effectiveness` ingest job)
23. Session shape clustering (`shape_label` on sessions: exploratory / implementation / debugging / planning)
24. Revert detection (`pull_requests.reverted_at` / `revert_of_pr_number`)
25. Jira key extraction (`pull_requests.jira_key` from branch/title pattern)
26. CI correlation via GitHub Checks (`sessions.pr_ci_status`, `sessions.pr_review_decision`, `pr_rollups.check_failures_count`)

### 12.6 Phase 6 — Hardening & Scale-Readiness ✓ done

Post-spine review of data-integrity, observability, and access-model gaps. Discriminated-union event schema + structured tool emission, Prometheus coverage for web + github-app, non-blocking transcript pipeline, explicit org-admin team-lead grants. Per-agent price tables and the hook adapter seam were deferred here and are decomposed in Phase 8. See `tasks/P6-roadmap.md`.

### 12.7 Phase 7 — Insight Surfaces & Search ✓ done

Close the gap between *captured* and *surfaced*. Before Phase 7, the friction score and session-shape label (Phase 5) were computed nightly but rendered in no UI, and transcript full-text search existed only at the org level.

27. Effectiveness widgets on "My Agents" — friction trend, session-shape mix, per-session friction band (`/me/insights`; honoring the §10.6 caveat: no misleading numbers for low-data sessions, version-pinned)
28. Team + org effectiveness distributions, gated by `visibility_policies`
29. Per-user transcript full-text search (`/me/search`, scoped to own sessions)
30. Faceted-search enrichment — shape, friction band, agent-type facets
31. Backfill of effectiveness signals over historical sessions
32. Gated spike: semantic (pgvector) transcript search (`embed-transcripts` ingest job, flag-controlled — completed as a no-go decision, not production-committed)

**Success criteria:** a dev sees their own friction trend and can search their own transcripts; a team lead sees a friction distribution without any individual's score leaking.

### 12.8 Phase 8 — Multi-Agent & Cost Model ✓ done

Prove the multi-agent spine §2.4 with a real second agent, and build the cost machinery a non-Anthropic agent needs.

33. `<agent>:<tool>` tool-name disambiguation (documented in §2.4; implemented at query time)
34. Per-agent + versioned price tables (the deferred P6-005) — cost keyed on `(agent_type, model)`, historically reproducible
35. Hook adapter seam (the deferred P6-006) — agent-neutral transport reused behind an adapter interface
36. A real second-agent adapter (`opencode`) that validates the seam end-to-end
37. Agent-driven user-facing copy (no hard-coded "Claude")
38. Gated: cost reconciliation against a vendor billing API (§13 Q4) — scaffolded behind a flag

A **third** adapter (`codex`, P8-007) was added after the phase's original scope. OpenAI Codex CLI's only stable hook is its turn-level `notify` program, with tool calls + token usage living in a separate rollout JSONL — so it exercised, and minimally extended, the seam: an optional `mapBatch` lets one turn-complete notification expand into the turn's tool events + a usage-bearing Stop read from the rollout (the first two adapters emit one event per hook and are unchanged). Its price table shipped with GPT-4o/o-series rates and was refreshed to the current OpenAI lineup (`gpt-5.x`, `gpt-5.3-codex`) in P12-010.

**Success criteria:** a second agent's sessions ingest, price correctly, render with correct labels, and never collide on tool names; the transport is shared between adapters without a fork.

### 12.9 Phase 9 — Alerting & Governance ✓ done

Move from passive dashboards to proactive, trust-preserving operation.

39. Alert rules engine — scheduled evaluation of spend spike / error rate / unknown-model thresholds, with persisted firing/resolving history (promotes the render-time anomaly detection of §12.4). Phase 10 added `routing_waste` and `autonomy_surge`, and `budget_threshold` is evaluated too; `budget_threshold` and `routing_waste` are seeded disabled, awaiting an operator-chosen threshold
40. Notification delivery (Slack / webhook, with an email seam pending SMTP wiring) + `/admin/alerts` config — aggregate data only, never individual content
41. Time-boxed transcript access grants — the §8.4 request/approve/expire workflow, replacing implicit standing org-admin reach
42. Per-team retention overrides on top of the global default
43. A narrow, grant-scoped research/investigator capability for Audience B (§3) — sampled session access only within an active, expiring, audited grant; no standing access

**Success criteria:** a spend spike fires a notification within one evaluation cycle; every privileged transcript view is the owner or a time-boxed approved grant, logged and visible to the viewed user.

### 12.10 Phase 10 — Model Cost Optimization

Turns the heuristic `/org/models` routing card into a defensible, governed optimization capability grounded in the per-agent price tables (`tasks/P10-roadmap.md`).

44. Routing analysis query layer with a savings model derived from real price tables rather than a flat heuristic
45. Org, team and individual routing guidance, plus a per-team routing-accountability table
46. `routing_waste` alert rule — premium-model spend on retrieval-only tool categories

**State:** partly shipped. Reconciled per task on 2026-08-18, after `INDEX.md` marked the phase `done` while every `P10-*.md` file read `ready`. Item 44's query layer and item 45's org/team surfaces exist (as `routing-queries.ts` and `/org/models`, reached through P8/P11 work) but miss named criteria, so `P10-001`/`P10-003` are `in-progress`; item 45's individual guidance was never built. Item 46's `routing_waste` rule ships. The governed half — a `model_policy` table and the `disallowed_model` rule — does not exist, so `P10-002`/`P10-005` are `ready`. `P10-006` is `cancelled`, superseded by `P13-006`'s projection registry. Per-task evidence is in `tasks/INDEX.md`.

### 12.11 Phase 11 — Correlation & Jira Integration

Shipped ahead of Phase 10 as a single vertical slice, deepening the session↔PR↔repo↔Jira spine.

47. Commit-SHA and open-PR link backfill, a configurable link window, and a manual-link UI
48. `pull_request_review` / `check_run` / `push` webhook capture (`pr_check_runs`, `pr_reviews`, `session_commit_links`)
49. Session-level `jira_key`, the env-gated `sync-jira` issue sync, and the true external business-value join
50. `/org/quality` defect attribution, with Fisher's exact significance testing on friction-band deltas

### 12.12 Phase 12 — Agent Adapter Expansion ✓ done

Takes the P8 seam from three agents to seven by extracting one stdin-hook factory rather than writing five bespoke adapters (`tasks/P12-roadmap.md`).

51. A shared `createStdinHookAdapter` factory; Codex moved onto its native lifecycle hooks
52. Gemini CLI, Copilot CLI, Pi and OMP adapters on that factory
53. Session-ID normalization in the seam, fixing a live bug that silently dropped opencode traffic
54. opencode transcript export, closing the P8-004 gap

**Success criteria:** seven agents ingest, price and render correctly through one transport. Three criteria remain unverified for want of the agents themselves — a recorded Pi session, which of omp's two documented config roots is real, and a recorded opencode session for the collated transcript.

### 12.13 Phase 13 — Scoring & Evaluation

Gives every computed signal provenance and a version, adds scorers that need no content access, captures human labels, and — once real data exists — validates the heuristics that already ship against real outcomes. Decomposed from `docs/research/2026-08-12-llm-evals-assessment.md` (`tasks/P13-roadmap.md`).

55. §5.2a `scores` — the versioned substrate. Scorer identity and version live in `packages/schemas/src/scores.ts`, so re-scoring history is a version bump plus one trigger rather than a bespoke backfill job
56. §5.2b `run_kind` — resolves §13 Q8 by construction
57. Six deterministic trajectory scorers (retry loops, edit thrash, redundant reads, denial-retry success, tests-before-merge, step efficiency), computed from the content-free capture in §5.3 — no transcript access
58. Skill and MCP-server effectiveness as first-class scored subjects
59. A versioned session rubric the owner answers about their own session, stored as `HUMAN` scores
60. A projection registry: predictions are recorded, later compared against what happened, and guarded so a "win" alongside rising friction is flagged rather than celebrated
61. An opt-in LLM-as-judge, off by default, own-sessions-only, audited and priced

**Sequenced against seed-only data.** No rollout has happened. Tasks are placed by two rules — build only what pays off regardless of whether rollout happens, and prefer what gets more expensive with time. Calibration, the validation surface, judge drift alerting, and arming the judge for other people's transcripts are all explicitly blocked on a data precondition (≥10 users over ≥60 days, ≥200 labelled sessions, ≥100 outcome-linked PRs) and unblock themselves when the corpus arrives.

**Success criteria:** every score carries the scorer and version that produced it; a scorer change re-scores history without new code; no CI or eval run reaches a number presented as developer behaviour; and no transcript reaches a model without its owner having opted in.

---

## 13. Open Questions

These were the decisions needed before Phase 1. Phases 7–9 task work is now done. Items still unresolved are noted as product or owner-input issues, not phase blockers.

| #   | Question                                                          | Notes                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **GitHub Enterprise Server, or github.com with an org?**          | **Resolved (2026-06-06):** Support both. `GITHUB_HOST` env var controls github.com vs GHES. Auth, webhooks, and the GitHub App all route through the host-abstracted `packages/github` Octokit wrapper. Default: `https://github.com`. |
| 2   | **Existing SSO (Okta / Azure AD)?**                               | **Resolved (2026-06-06):** GitHub OAuth now; document the `IdentityProvider` interface seam for Okta/Azure later. No implementation in Phase 4. See `packages/auth/src/` for the extension point. |
| 3   | **Transcript retention period?**                                  | **Resolved (2026-06-06):** Configurable via `TRANSCRIPT_RETENTION_DAYS` env var in `apps/ingest`. Default: 365 days. Set to 0 to disable automatic deletion. The `sweep-retention` job enforces this nightly. |
| 4   | **Cost data source — client-computed vs Anthropic admin API?**    | Defaulting to client-computed for v1; revisit if accuracy disputes arise                                                                                                                                                       |
| 5   | **Mandate hook installation, or opt-in?**                         | At 200 devs, opt-in produces sampling bias. Mandated install via existing dev config feels right but needs leadership cover                                                                                                    |
| 6   | **Does S1 have a branch/PR naming convention that ties to Jira?** | If yes, feature-level rollups are nearly free. If no, PR-level is the practical ceiling for v1. *(Update: key extraction now also covers PR title/body and the session's branch, and the full Jira REST sync (`sync-jira` job → `jira_issues`) is implemented and env-gated — it activates as soon as `JIRA_BASE_URL`/`JIRA_API_TOKEN` credentials are provided, which remains the open owner-input item.)* |
| 7   | **Does the dev tools team operate the service, or another team?** | Affects on-call rotation, SLO targets, and infrastructure choices                                                                                                                                                              |
| 8   | **Are CI-side Claude Code runs in scope?**                        | Currently out of scope for v1. May want to revisit — CI sessions look different (no human prompts) and could distort aggregates                                                                                                |
| 9   | **PR bot opt-in repo-by-repo, or org-default-on with opt-out?**   | Default-on is more useful but more politically loaded                                                                                                                                                                          |
| 10  | **Replace or complement any existing telemetry pipelines?**       | The earlier draft referenced an existing DataSet pipeline; that reference was based on prior context, not this conversation. Needs explicit confirmation of what (if anything) exists today and how this service relates to it |

---

## 14. Trade-Offs Made

| Trade-off                                                 | Choice                        | What we gave up                                                                                                      |
| --------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ClickHouse vs Timescale                                   | Timescale                     | Best-in-class analytical query speed; gained operational simplicity                                                  |
| Mandatory full-fidelity capture vs minimal hook           | Full per-event capture        | More client-side complexity; gained answer-anything-later data                                                       |
| Store raw tool I/O in events vs hash-and-blob             | Hash-and-blob                 | Cannot re-query specific inputs in SQL; gained massive storage savings and compliance posture                        |
| Default-share-everything vs default-private               | Default-private (transcripts) | Less data visible to leadership day one; gained developer trust, which is the gating factor for adoption             |
| Build a custom UI vs reuse Grafana                        | Custom UI                     | Slower to MVP; gained "My Agents" experience, transcript viewing, privacy controls — none of which Grafana does well |
| Single hook binary vs language-native hooks               | Single Bun-compiled binary    | Slightly higher distribution complexity; gained batching, retry, queue, OIDC — needed at scale; keeps codebase in one language |
| OAuth App = GitHub App                                    | Two apps                      | More setup; gained clean permission boundaries                                                                       |
| Capture lots now / surface later vs capture-what-you-need | Capture more                  | Larger storage footprint; gained ability to answer new questions without backfilling from transcripts                |
| Cost: client-computed price table vs Anthropic admin API  | Client-computed               | Slight risk of price-table drift; gained simplicity and decoupling                                                   |

---

## 15. Future Directions

Beyond Phase 5, the natural extensions:

- **Cross-tool unification.** If S1 captures Cursor / Copilot / VSCode telemetry, join on user_id for an honest "AI tooling effectiveness" picture rather than a Claude-only view.
- **Skill quality feedback loop.** Skills with high invocation but low downstream tool success could be flagged for revision. Skill authors get a dashboard.
- **MCP server health monitoring.** Treat each MCP server as a service with its own SLO (success rate, latency). Devs see which MCP integrations are flaky.
- **Cohort analysis.** Devs grouped by adoption date, role, team — does effectiveness diverge over time?
- **Recommendation surface.** "Devs working on similar problems used these skills / MCP servers / patterns." Carefully — this is one step away from a creepy nudge engine.
- **Public API.** Allow other internal tools (engineering dashboards, finance reporting) to query rollups via authenticated API.
- **Open-source spin-off.** If the data model and ingest API are clean, this could become a public Claude Code observability project. Decouples Propixel-style consulting opportunity from S1-internal scope.
- **Anthropic admin API integration.** Pull billed amounts as ground truth; reconcile against client-computed costs to catch drift.

---

## 16. Glossary

| Term                      | Meaning                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent / agent_type**    | The AI coding agent producing the telemetry. `CLAUDE_CODE` is v1; the schema also carries `CURSOR`, `AIDER`, `COPILOT`, `CODEX`, `WINDSURF`, `OPENCODE`, `GEMINI_CLI`, `PI`, `OMP`. Live adapters: `CLAUDE_CODE`, `OPENCODE` (P8), `CODEX` (P8-007/P12-004), `GEMINI_CLI`, `COPILOT`, `PI`, `OMP` (P12). |
| **Session**               | One contiguous agent conversation, identified by the agent's native `session_id`                                                                   |
| **Event**                 | A single hook fire — `PreToolUse`, `PostToolUse`, `Stop`, etc.                                                                                     |
| **Turn**                  | One user-prompt-and-response cycle within a session                                                                                                |
| **Hook**                  | A Claude Code lifecycle event handler; the source of all real-time telemetry                                                                       |
| **Transcript**            | The full `~/.claude/projects/<encoded>/<sid>.jsonl` file, every message and tool result                                                            |
| **PR rollup**             | Aggregated metrics for all sessions that contributed to a pull request                                                                             |
| **Visibility policy**     | Per-user privacy controls for what's visible to team / org                                                                                         |
| **Audit log**             | Record of every privileged access to another user's data                                                                                           |
| **My Agents**             | The per-developer self-service dashboard; the trust anchor of the product                                                                          |
| **Aggregate-only viewer** | Role for leadership/finance — sees org rollups, never individual sessions                                                                          |
| **Score**                 | One row in `scores` (§5.2a): a value or label, plus which scorer produced it and at what version. The unit of everything Phase 13 computes           |
| **Scorer**                | A named, versioned function producing scores. Declared once in `packages/schemas/src/scores.ts`; bumping its version and triggering a rescore replaces what used to be a bespoke backfill job |
| **Source**                | Where a score came from: `HEURISTIC` (friction), `DETERMINISTIC` (the trajectory scorers), `HUMAN` (the session rubric), `JUDGE` (an LLM), `OUTCOME` (a real-world result — merged, reverted, CI green) |
| **Trajectory metric**     | A deterministic score over the *shape* of a session's tool sequence rather than its content — retry loops, edit thrash, redundant reads, step efficiency. Computable because of the content-free capture (§5.3) |
| **Run kind**              | `INTERACTIVE` \| `CI` \| `EVAL` (§5.2b). Non-interactive runs are stored and trendable but never enter a number presented as developer behaviour     |
| **Outcome oracle**        | This platform's structural advantage over a generic eval harness: it already knows whether the work *landed* — the PR merged, CI passed, nothing reverted it. A judge scores what a session looked like; the oracle knows how it turned out |
| **LLM-as-judge**          | A model scoring a session against a rubric. Opt-in per user, off by default, own-sessions-only, audited, and priced — the only place the platform sends conversation content to a model |
| **Projection**            | A recorded prediction (e.g. "this routing change saves $X/mo") that is later compared against what actually happened, with an outcome guard so a "win" alongside rising friction is flagged rather than celebrated |
| **Gold set**              | A held-out set of human-labelled sessions used to calibrate a scorer — the thing that says whether a judge or heuristic agrees with people                                     |

---

## 17. Document History

| Date       | Author              | Change        |
| ---------- | ------------------- | ------------- |
| 2026-05-16 | Jorge (with Claude) | Initial draft |
| 2026-06-24 | Jorge (with Claude) | Added Phases 6–9 to §12 (Hardening, Insight Surfaces & Search, Multi-Agent & Cost Model, Alerting & Governance); scoped threshold-based alerting out of the §2.2 non-goal |
| 2026-06-25 | Jorge (with Claude) | Updated §12.3 and §12.4 with P3/P4 dashboard additions (date range selector, period-over-period deltas, team PR tab, org adoption funnel, model governance table, cache efficiency metric); updated §10.2 with cache efficiency and period-delta computation notes; updated status header |
| 2026-06-25 | Jorge (with Claude) | Full doc audit against codebase: updated status header to reflect current task status; added §6.5 scheduler jobs table; updated §2.2 alerting note; updated §2.4 agent_type enum; added Phase 5 fields to Session + PullRequest + PRRollup DDL; added continuous aggregate definitions to §5.3; removed "Optional" from §5.5; expanded §6.2 hook commands and adapter seam; added INVESTIGATOR role to §8.1; added §8.4 grant model; marked Phases 5–9 status in §12; added additional dashboard routes to §12.4; updated §16 glossary agent_type entry |
| 2026-06-30 | Jorge (with Claude) | Added §10.3a Human-in-the-loop signals (permission/autonomy mode capture, notification classification, response latency, oversight dashboards, alert ack/silence, `autonomy_surge` rule, AI-authored-code provenance, per-session feedback) following the HITL assessment in `docs/research/2026-06-30-human-in-the-loop-assessment.md` |
| 2026-07-10 | Jorge (with Claude) | Correlation deepening: session-level `jira_key` + `team_id` FK (§5.2); `pr_check_runs`, `pr_reviews`, `session_commit_links`, `jira_issues` tables + hardened session↔PR backfill (SHA matching, open-PR linking, configurable window, manual link UI) (§5.4); `sync-jira` job (§6.5); `pull_request_review`/`check_run`/`push` webhook handling (§7.2); updated §2.3 and §13 Q6 accordingly |
| 2026-07-11 | Jorge (with Claude) | Follow-ups: per-team **routing accountability** table on `/org/models` (observe-only substitute for hook-side routing enforcement, `§10.3a`); **true external business-value join** (`JIRA_VALUE_FIELD` → `jira_issues.business_value`, `sync-jira`) preferred over the flat `VALUE_PER_STORY_POINT` proxy on `/org/roi`; operator-triggered `backfill-redaction` job populating `sessions.redaction_flags` for pre-column transcripts by scanning stored text for `[REDACTED:<class>]` markers |
| 2026-07-13 | Jorge (with Claude) | Two new redaction classes (§9.1): **URL-embedded credentials** (`git-remote-url` — scrubs `scheme://user:secret@host` userinfo, runs after the token rules so a known token keeps its own class) and **email** addresses (PII); fixed `/org/security`'s redaction-class labels to key by the persisted rule names |
| 2026-08-14 | Jorge (with Claude) | Rebased Phase 13 onto Phase 12 (seven-agent adapter seam). The content-free tool capture (`tool_target_hash`, `tool_action`) moved into the shared `buildGenericToolInfo` factory and the Pi/omp builder, so every agent produces it on its hook path rather than Claude Code alone — without that, the three target-keyed trajectory scorers would be silently dead for Gemini CLI, Copilot CLI, Codex, Pi and omp. One path genuinely cannot: Codex's legacy rollout-file reader records only byte counts per tool call, never the arguments, so it emits `null` and says so — the scorers exclude unobservable calls rather than bucketing them together and inventing repeats. `toolRole()` gained a shared self-describing-name layer for the same reason: enumerating every new agent's vocabulary is not possible, and an unknown name still resolves to `other` so a scorer stays silent rather than guessing |
| 2026-08-12 | Jorge (with Claude) | Phase 13 implementation: §5.2a `scores` (the versioned scoring substrate — scorer identity, provenance, re-scoring without a bespoke backfill) and §5.2b `run_kind` (INTERACTIVE/CI/EVAL, resolving §13 Q8 by construction); `rescore-effectiveness` added to the §6.5 job table |
| 2026-08-12 | Jorge (with Claude) | Scoped the §2.2 "prompt evaluation" non-goal to *model/agent benchmarking*: evaluating the platform's own computed signals against real engineering outcomes is now a goal, decomposed as Phase 13 (Scoring & Evaluation — `tasks/P13-roadmap.md`) following `docs/research/2026-08-12-llm-evals-assessment.md`. Updated the status header accordingly |
| 2026-07-13 | Jorge (with Claude) | Real `reconcile-cost` billing client: `AnthropicBillingSource` backed by the Admin **Cost Report API** (`ANTHROPIC_ADMIN_KEY`, optional `ANTHROPIC_COST_WORKSPACE_ID`), replacing the null placeholder — sums the org's Anthropic-billed cost per month (cents→USD, paginated) for `CLAUDE_CODE`, feeding the existing delta/drift reconciliation (§6.5) |
| 2026-08-14 | Jorge (with Claude) | **Migration squash** (pre-deployment, one-off): nine `sql/migrations/` files merged into `0001_init.sql` and the Prisma chain into `20260814000000_init/`. The old chain created the three continuous aggregates and then dropped and recreated them twice more within the same deploy, which destroyed materialized history and intermittently failed the deploy with `tuple concurrently deleted`. Each aggregate is now defined once, already filtered to `run_kind = 'INTERACTIVE'`; the resulting schema was verified identical to the one the old chain produced |
| 2026-08-18 | Jorge (with Claude) | Documentation audit against the code. Corrected the §2.2 and §12.9 claim that `budget_threshold` is "reserved but not evaluated" (all six alert rule types are evaluated; two are seeded disabled pending an operator threshold); narrowed §5.2b's "every human-facing surface filters to `INTERACTIVE`" to what the lints actually enforce, and named the three deliberately-unfiltered read classes; added the four missing `events` columns to §5.3 (`run_kind`, `notification_kind`, `tool_target_hash`, `tool_action`) with their partial indexes; added Phase 13 vocabulary to §16 |
| 2026-08-18 | Jorge (with Claude) | Rebased Phase 13 onto the post-revamp UI/UX review (#112). The substantive integrations: `SessionFeedbackForm` keeps the rubric but moves onto `useActionResult`, so a failed save shows an inline error instead of a false "Saved"; the audit feed's action labels take main's uppercase enum keys — a lowercase copy had made the filter silently never match — with `JUDGE_READ_TRANSCRIPT` folded in and `VALID_ACTIONS` derived from the map so the two cannot disagree; and `/org/models` drops the two type imports that the removed hardcoded-savings banner was the last consumer of |
| 2026-08-18 | Jorge (with Claude) | Rebased Phase 13 onto the price-table refresh (#113). No adjustment was needed: that change normalizes provider token semantics in the adapters and prices models through a `<provider>/` fallback, none of which the scoring substrate reads. It does interact with one alert — `unknown_model_surge` fires on `cost_usd = 0 AND input_tokens > 0`, so filling the four empty tables and correcting two stale ones removes most of what it was firing on. That is the fix working, not a regression |
| 2026-08-26 | Jorge (with Claude) | **Migration squash** (pre-deployment, P14-009): the custom SQL layer back to one file. Phase 14 had grown it to four — `0003_tool_cost_attribution.sql` (P14-004) and `0004_live_turn_linkage.sql` (P14-006) were folded into `0001_init.sql`, columns and comments and the partial `events_session_tool_use_id_idx` intact, and each file's `CREATE OR REPLACE VIEW interactive_events` dropped, since it only existed because the columns arrived after the view. `0002_tool_category_backfill.sql` was deleted rather than folded: a pure data backfill has nothing to do on a database created from the consolidated file. Verified against a real database — a `pg_dump` diff over 2465 lines showed 26 changed lines, all of them physical column order (what folding an `ALTER` into a `CREATE` does) plus pg_dump's own per-run nonce; the Timescale catalogs were identical; `interactive_events` was confirmed to carry all three folded columns via `information_schema.columns`; and the untouched Prisma layer still regenerates to the same 118 statements. Anyone with an existing local database **must reset** — `applySqlMigrations()` will not re-run a filename already in `_db_sql_migrations` |
