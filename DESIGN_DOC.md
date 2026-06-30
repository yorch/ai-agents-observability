# ai-agents-observability — Design Document

**Project:** `ai-agents-observability`
**Status:** Phases 7–9 task work is done; remaining open task statuses are operational sign-off / integration items in P1–P2 plus P6 deferrals superseded by P8
**Owner:** Jorge (SentinelOne)
**Last updated:** 2026-06-25
**Audience:** Internal — dev tools team, leadership stakeholders

---

## 1. Executive Summary

`ai-agents-observability` is a self-hosted observability platform for AI coding agents — Claude Code first, with OpenCode and Codex CLI adapters now implemented. The data model remains designed to accommodate Cursor, Aider, and other agentic developer tools later. It ingests per-event telemetry from developer machines, archives full session transcripts, correlates work to pull requests and GitHub teams, and exposes dashboards and reporting for three audiences: individual developers, team leads, and org-level stakeholders.

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
- Real-time alerting / SIEM-style behavioral analytics on session content. *(Update: threshold-based operational alerting — spend spikes, error-rate, unknown-model surges — is implemented in Phase 9 §12.9. `budget_threshold` rule type is reserved in the enum but not yet evaluated. SIEM-style behavioral analytics on transcript content remains out of scope.)*
- Replacing any existing observability stack (Datadog, Splunk, etc.) — this is purpose-built for AI coding agent telemetry.
- **Model-level observability** — inference latency, prompt evaluation, model drift, RAG quality. Out of scope by design; that's a different product.
- Capturing telemetry from every possible coding agent. OpenCode and Codex adapters are implemented; Cursor, Aider, Copilot, and Windsurf remain future adapters.
- Computing line-of-code-generated style "AI productivity" headline numbers (explicitly avoided — see §10).

### 2.3 Explicitly Deferred

- Bug correlation (link bugs in Jira/Linear back to AI-touched PRs).
- IDE telemetry joins (overlap with VSCode/Cursor sessions).
- CI / lint / test failure correlation via GitHub Checks API.
- Revert detection through git history scanning.
- Capture from CI-side agent runs (v1 focuses on interactive developer sessions).
- Cursor / Aider / Copilot / Windsurf adapters (deferred; data model is forward-compatible).

### 2.4 Multi-Agent Extensibility

The name `ai-agents-observability` is deliberately plural. Claude Code was the first agent integrated, and Phase 8 added OpenCode plus Codex adapters. Every schema decision in this document is made with the assumption that more agents will be added later.

Concretely, this means:

- An `agent_type` dimension exists on every event and session (defaulting to `CLAUDE_CODE` in v1). The enum as shipped: `CLAUDE_CODE`, `CURSOR`, `AIDER`, `COPILOT`, `CODEX`, `WINDSURF`, `OPENCODE`. Adapters for `OPENCODE` (Phase 8) and `CODEX` (P8-007) are implemented; the others have schema entries but no adapter yet.
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

  -- Effectiveness signals (computed by ingest scheduler; see §10.2)
  shape_label             TEXT,         -- 'exploratory'|'implementation'|'debugging'|'planning'
  friction_score          NUMERIC(5,2), -- composite: retries + denials + interrupts + abandonment

  -- GitHub enrichment (populated from webhook context)
  pr_ci_status            TEXT,         -- last check-run conclusion for the PR (P5-005)
  pr_review_decision      TEXT,         -- 'APPROVED'|'CHANGES_REQUESTED'|'REVIEW_REQUIRED' (P5-005)
  github_login            TEXT,         -- denormalized from users for fast filtering
  github_team             TEXT,         -- primary team slug at session start
  project_name            TEXT          -- display name derived from repo/cwd
);
CREATE INDEX ON sessions (user_id, started_at DESC);
CREATE INDEX ON sessions (repo_id, started_at DESC);
CREATE INDEX ON sessions (pr_number) WHERE pr_number IS NOT NULL;
CREATE INDEX ON sessions (status, last_event_at);
CREATE INDEX ON sessions (agent_type, started_at DESC);
```

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

  metadata              JSONB,

  PRIMARY KEY (session_id, event_id, ts)
);
SELECT create_hypertable('events', 'ts', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON events (user_id, ts DESC);
CREATE INDEX ON events (session_id, ts);
CREATE INDEX ON events (tool_name, ts DESC) WHERE tool_name IS NOT NULL;
CREATE INDEX ON events (mcp_server, ts DESC) WHERE mcp_server IS NOT NULL;
CREATE INDEX ON events (skill_name, ts DESC) WHERE skill_name IS NOT NULL;
CREATE INDEX ON events (agent_type, ts DESC);
```

**Compression:** A 7-day compress policy runs on the hypertable, segmented by `(user_id, session_id)`.

**Continuous aggregates (materialized, 1-hour refresh):**
- `daily_cost_by_user` — `(day, user_id, agent_type)` → token totals and cost
- `daily_cost_by_model` — `(day, model, agent_type)` → token totals and cost
- `daily_tool_usage` — `(day, tool_name, tool_category, agent_type)` → call counts

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
- **Hook adapter seam** (Phase 8): each agent has its own adapter (`claude-code.ts`, `opencode.ts`, `codex.ts`). The transport (batching, queue, flushing, auth) is shared; adapters handle event translation. An optional `mapBatch` lets one hook fire expand into multiple events (used by the Codex adapter to read rollout JSONL).

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
  "parent_event_id": "01939f6c-...-pretooluse",

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

### 6.4 Transcript Shipping

At `Stop` and on a 10-minute heartbeat for long-running sessions:

1. Read `~/.claude/projects/<encoded>/<session_id>.jsonl`
2. Run redaction pass (see §9)
3. Compress with **zstd**, streaming the redacted lines through `node:zlib`'s `createZstdCompress` so the full uncompressed transcript never sits in memory. The ingest service still accepts **gzip** for backward compatibility, but it always decompresses, re-redacts as defense-in-depth, and re-compresses to zstd for storage — so the stored object is always `.jsonl.zst` regardless of the upload encoding
4. `POST /v1/transcripts/{session_id}` with `Content-Range` for chunked / resumable upload
5. Server writes to MinIO/S3 at `transcripts/{yyyy}/{mm}/{dd}/{user_id}/{session_id}.jsonl.zst`
6. On final chunk, update `sessions.transcript_*` columns

### 6.5 Ingest Scheduler Jobs

`apps/ingest` runs scheduled background jobs from `apps/ingest/src/jobs/scheduler.ts`. Nightly jobs are configured in the `job_config` table and can be enabled, disabled, rescheduled, or manually triggered from `/admin/jobs`; fixed-cadence jobs run from in-process intervals.

| Job | Schedule | Purpose |
|---|---|---|
| `sweep-abandoned` | every 10 min | Marks stale ACTIVE sessions as ABANDONED (no event for >30min) |
| `sweep-scratch` | hourly | Cleans up orphaned transcript chunk scratch files |
| `sync-teams` | hourly | GitHub team membership sync for all orgs |
| `run-deletions` | every 6h | Processes queued GDPR `DeletionRequest` rows |
| `sweep-retention` | configurable, default 02:00 UTC | Deletes transcripts (S3 + `transcript_s3_key`) past the global or per-team retention window |
| `index-transcripts` | configurable, default 03:30 UTC | Populates `transcript_index` for Postgres FTS |
| `compute-effectiveness` | configurable, default 05:00 UTC | Computes `friction_score` + `shape_label` on sessions |
| `evaluate-alerts` | configurable, default 01:00 UTC | Evaluates alert rules; fires/resolves `AlertEvent` rows and sends configured notifications |
| `reconcile-cost` | daily when `BILLING_RECONCILIATION_ENABLED=true` | Gated cost reconciliation vs vendor billing API (P8-006; currently ships with a null billing source) |
| `compute-effectiveness-backfill` | operator-triggered only | One-shot historical effectiveness backfill, intentionally not exposed through `/admin/jobs` |

### 6.6 Identity Trust Model

`user_id_claim` from the hook is informational. **The authoritative user identity comes from the auth token on the ingest request**, not from the payload. If a hook claims to be `alice` but the token belongs to `bob`, the events are stored as `bob` and a `suspicious_identity_claim` flag is logged.

### 6.7 Cost Source of Truth

Client computes cost from token counts × a **versioned price table** served by the service. Clients fetch and cache the price table daily. Anthropic price changes propagate without redeploying hooks.

(Alternative considered: pull billed amounts from Anthropic's admin API. Adds a dependency; deferred.)

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
- On merge: finalize PR rollup, compute final cost, link contributing sessions, snapshot lines changed
- Webhook for `push` on default branch: optional commit→sessions correlation via author + timestamp window
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

Matches are replaced with `[REDACTED:type]` placeholders (square brackets, not angle brackets — the markers must survive being rendered as HTML in the transcript-search excerpt view without being mistaken for a tag). The transcript is tagged `transcript_redacted=true` with a list of redaction classes encountered.

### 9.2 Deferred Redaction Work

- ML-based PII detection (names, emails of non-employees, phone numbers in customer data)
- Repo-specific redaction policies (e.g., "this repo touches PHI, scrub harder")
- Per-user opt-in to stronger redaction tiers
- Re-redaction sweeps when new patterns are added

### 9.3 What is Never Stored Server-Side

- Raw tool inputs and outputs (only hashes and sizes go to `events`)
- Raw prompts in the events table (full prompts only in the transcript blob, post-redaction)
- Unredacted secrets that match day-one patterns

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
- Cost (computed client-side from versioned price table)
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
- **Surfaces** — an "Oversight & Autonomy" panel + rubber-stamp/over-trust detector on `/me`; a mode search facet; a `/org/governance` oversight-posture + AI-authored-code-provenance report; per-session human feedback (`session_feedback`).
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

### 11.6 Cost Computation: Client-Side, Versioned Table

**Choice:** Client computes from token counts × a service-served price table; clients refresh daily.

**Rationale:**

- Anthropic price changes don't require hook redeploy
- Ground truth (Anthropic admin API) is heavier dependency; deferred

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
- `/admin/adapters` — per-agent adapter status (last-seen session, 7d session count)
- `/admin/jobs` — background job config (enable/disable individual scheduler jobs, trigger on demand)
- `/admin/price-tables` — manage per-agent/per-model price tables

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

A **third** adapter (`codex`, P8-007) was added after the phase's original scope. OpenAI Codex CLI's only stable hook is its turn-level `notify` program, with tool calls + token usage living in a separate rollout JSONL — so it exercised, and minimally extended, the seam: an optional `mapBatch` lets one turn-complete notification expand into the turn's tool events + a usage-bearing Stop read from the rollout (the first two adapters emit one event per hook and are unchanged). It ships an empty `codex` price table — every Codex model bills `$0` via the table until real OpenAI rates are filled in.

**Success criteria:** a second agent's sessions ingest, price correctly, render with correct labels, and never collide on tool names; the transport is shared between adapters without a fork.

### 12.9 Phase 9 — Alerting & Governance ✓ done

Move from passive dashboards to proactive, trust-preserving operation.

39. Alert rules engine — scheduled evaluation of spend spike / error rate / unknown-model thresholds (`budget_threshold` is reserved in the rule-type enum but not yet evaluated), with persisted firing/resolving history (promotes the render-time anomaly detection of §12.4)
40. Notification delivery (Slack / webhook, with an email seam pending SMTP wiring) + `/admin/alerts` config — aggregate data only, never individual content
41. Time-boxed transcript access grants — the §8.4 request/approve/expire workflow, replacing implicit standing org-admin reach
42. Per-team retention overrides on top of the global default
43. A narrow, grant-scoped research/investigator capability for Audience B (§3) — sampled session access only within an active, expiring, audited grant; no standing access

**Success criteria:** a spend spike fires a notification within one evaluation cycle; every privileged transcript view is the owner or a time-boxed approved grant, logged and visible to the viewed user.

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
| 6   | **Does S1 have a branch/PR naming convention that ties to Jira?** | If yes, feature-level rollups are nearly free. If no, PR-level is the practical ceiling for v1                                                                                                                                 |
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
| **Agent / agent_type**    | The AI coding agent producing the telemetry. `CLAUDE_CODE` is v1; the schema also carries `CURSOR`, `AIDER`, `COPILOT`, `CODEX`, `WINDSURF`, `OPENCODE`. Live adapters: `CLAUDE_CODE`, `OPENCODE` (P8), `CODEX` (P8-007). |
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

---

## 17. Document History

| Date       | Author              | Change        |
| ---------- | ------------------- | ------------- |
| 2026-05-16 | Jorge (with Claude) | Initial draft |
| 2026-06-24 | Jorge (with Claude) | Added Phases 6–9 to §12 (Hardening, Insight Surfaces & Search, Multi-Agent & Cost Model, Alerting & Governance); scoped threshold-based alerting out of the §2.2 non-goal |
| 2026-06-25 | Jorge (with Claude) | Updated §12.3 and §12.4 with P3/P4 dashboard additions (date range selector, period-over-period deltas, team PR tab, org adoption funnel, model governance table, cache efficiency metric); updated §10.2 with cache efficiency and period-delta computation notes; updated status header |
| 2026-06-25 | Jorge (with Claude) | Full doc audit against codebase: updated status header to reflect current task status; added §6.5 scheduler jobs table; updated §2.2 alerting note; updated §2.4 agent_type enum; added Phase 5 fields to Session + PullRequest + PRRollup DDL; added continuous aggregate definitions to §5.3; removed "Optional" from §5.5; expanded §6.2 hook commands and adapter seam; added INVESTIGATOR role to §8.1; added §8.4 grant model; marked Phases 5–9 status in §12; added additional dashboard routes to §12.4; updated §16 glossary agent_type entry |
| 2026-06-30 | Jorge (with Claude) | Added §10.3a Human-in-the-loop signals (permission/autonomy mode capture, notification classification, response latency, oversight dashboards, alert ack/silence, `autonomy_surge` rule, AI-authored-code provenance, per-session feedback) following the HITL assessment in `docs/research/2026-06-30-human-in-the-loop-assessment.md` |
