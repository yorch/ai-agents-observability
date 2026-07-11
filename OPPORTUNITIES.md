# Opportunities & Additional Value from AI Agent Telemetry

**Companion to:** [`DESIGN_DOC.md`](DESIGN_DOC.md)
**Status:** Assessment — pre-roadmap
**Last updated:** 2026-06-25
**Audience:** Internal — dev tools team, leadership, DX researchers

---

## 1. Overview

`ai-agents-observability` captures more data than it currently surfaces. The schema contains per-turn model selection, MCP server calls, skill invocations, friction scores, session shapes, PR outcomes, and full conversation transcripts — most of which power only a subset of the existing dashboards.

This document catalogs what additional outputs and benefits a company can extract from this telemetry, assesses feasibility against the current data model, and identifies the highest-value opportunities by impact-to-effort ratio.

This is not a roadmap. It is an input for deciding what to build next.

---

## 2. What the Data Contains

Understanding the opportunity space requires a clear map of what is already captured.

| Layer | What is stored | Key dimensions |
|---|---|---|
| **Events firehose** (Timescale hypertable) | Every hook fire: tool name/category, duration, exit status, bytes, permission events, MCP server+tool, skill name, slash command, model, tokens, cost, mode | `user_id`, `session_id`, `agent_type`, `ts`, `tool_name`, `tool_category`, `mcp_server`, `skill_name`, `model` |
| **Sessions** | Lifecycle, git context, aggregated token/cost/tool counts, friction score, session shape label, transcript pointer | `user_id`, `repo_id`, `pr_number`, `shape_label`, `friction_score`, `primary_model`, `agent_type` |
| **PR rollups** | All sessions contributing to a PR: cost, tool calls, lines changed, time-to-merge, CI failures, review count | `repo_id`, `pr_number`, `contributing_user_ids`, `check_failures_count`, `cost_per_loc` |
| **Pull requests** | GitHub metadata: state, reviewers, labels, revert status, Jira key, CI/review decision | `reverted_at`, `revert_of_pr_number`, `jira_key`, `pr_ci_status`, `pr_review_decision` |
| **Transcripts** | Full conversation JSONL, redacted and FTS-indexed | `session_id`, full-text via `transcript_index` |
| **Visibility policies + audit log** | Per-user sharing consent; every privileged data access | All individual access is logged and visible to the subject |

**Notably captured but largely unsurfaced today:**

- Per-turn model (enables model routing analysis, not just per-session primary model)
- MCP server × tool call volume and error rates
- Session shape and friction score (computed nightly; Phase 7 display work is done)
- `compaction_count` and `clear_count` (context window pressure signals)
- `tool_input_bytes` / `tool_output_bytes` (data volume flowing through AI)
- `subagent_type` (multi-agent orchestration patterns)
- `slash_command` (power-user adoption signal)

---

## 3. Additional Outputs & Benefits

### 3.1 Engineering ROI — Outcome-Based, Not Vanity Metrics

**The problem with existing AI ROI metrics:** Most orgs measure lines-of-code generated or "acceptance rate" — both of which reward verbosity and can be gamed. This platform has the data for outcome-based ROI.

**What this data enables:**

- **Cost-per-merged-PR**: already in the schema (`pr_rollups.total_cost_usd`). Trend over time as developers get more effective.
- **Cost-per-feature**: `pull_requests.jira_key` extraction is already implemented. Join PR rollups to Jira/Linear epics for feature-level cost attribution without manual tracking.
- **Avoided rework cost**: `pull_requests.reverted_at` marks PRs that were reverted. A session contributing to a reverted PR represents wasted AI spend — measurable, and potentially correlated with session characteristics (high friction? rushed? no planning phase?).
- **PR cycle time impact**: did AI-assisted PRs merge faster or slower than the team baseline? `pull_requests.opened_at` → `merged_at` is captured; compare cohorts by AI session involvement.
- **True multiplier estimate**: for sessions with a clear implementation shape (low exploration, high edit/write ratio), duration × estimated manual time for the same task gives a productivity multiple. Requires a calibration assumption but is far more defensible than LOC metrics.

**What is missing:** A connection to business value (sprint story points, feature flags, revenue). This requires an external join (Jira, Linear, or LaunchDarkly) and is currently deferred (see `DESIGN_DOC.md §2.3`).

**Feasibility:** High. The session → PR → Jira chain is partially built. Adding an executive "ROI" stat card to the org dashboard is a UI task once the join is defined.

> **Partially shipped (2026-06-30):** `/org/roi` now surfaces the internal-join ROI
> metrics — agent spend, cost-per-merged-PR, reverted (rework) spend, a clean-CI vs
> CI-failed cost comparison, spend-by-Jira-key cost allocation, and per-repo ROI
> (cost/PR + revert + CI-clean rate). A **configurable business-value join** now
> ships too: set `VALUE_PER_STORY_POINT` and `/org/roi` shows value-delivered
> (delivered story points × the rate) vs agent spend, a net-value figure, and a
> return multiple. A *true* external revenue/outcome join (pulling real business
> value rather than a configured per-point rate) remains deferred.

---

### 3.2 Model Cost Optimization

**The opportunity:** The `model` column is captured **per-turn**, not just per-session. Most teams treat model selection as a session-level or policy-level decision ("always use Sonnet"). Turn-level data reveals whether that's right.

**What this data enables:**

- **Model usage by task type**: cross `model` with `tool_category` in the events table. Are developers using expensive models (Opus) for file reads? For Bash commands? Session-shape `exploratory` vs. `implementation` segments this further.
- **Cache efficiency as a cost lever**: `cache_read_tokens / (input_tokens + cache_read_tokens)` is already surfaced as a team stat card. Teams at 10% cache efficiency vs. 60% on similar work pay 5× more for context. This is a teachable, measurable improvement.
- **Per-model cost distribution**: `daily_cost_by_model` continuous aggregate already exists. Trend by team and compare to the tasks being done.
- **Model governance enforcement**: unauthorized model usage is detectable from the events table before the invoice arrives. The org model governance table (already built for Phase 4) can drive alerting, not just reporting.

**Potential savings:** In real deployments, model routing (using cheaper models for simpler tasks) commonly reduces AI spend by 30–50% with no productivity loss. This data provides the empirical basis to make those routing decisions rather than guessing.

**Feasibility:** High. Data is all there. The recommendation surface ("you could save X by routing these task types to Haiku") is a new UI component but a straightforward SQL query.

> **Shipped:** `/org/models` carries a **routing-recommendations** panel — for each premium (Opus-class) model, it estimates the spend on retrieval-only tool categories (`fs_read`, `search`) that could move to a Haiku-class model. The saved fraction is now **derived per-model from the ingest price table** (`GET /v1/price-table`: `1 − haikuInputRate/premiumInputRate`, capped at 95%), falling back to the flat ~90% heuristic only when `INGEST_URL` is unset. A **`routing_waste` alert rule** (seeded, disabled by default) promotes the same signal to a proactive notification when premium-on-retrieval spend crosses a threshold. Cache-efficiency guidance shares the page. True enforcement (auto-route/block) still needs a hook-side path.

---

### 3.3 MCP Server Portfolio Management

**The opportunity:** `mcp_server` and `mcp_tool` are first-class event dimensions, but today only an adapter status page surfaces them. MCP integrations have real maintenance cost; the data can inform which ones earn their keep.

**What this data enables:**

- **MCP utilization**: which servers have zero invocations in the last 30 days? Deprecation candidates.
- **MCP error rates**: `tool_exit_status` on MCP events reveals which integrations are unreliable. Treat each MCP server as a service with its own SLO (error rate, p95 latency via `tool_duration_ms`).
- **MCP adoption spread**: is the data engineering team's database MCP server being discovered by product engineers? Cross-team MCP adoption is organic knowledge transfer — worth surfacing.
- **Security surface audit**: every external service accessed via MCP is a data egress point. A report of "MCP calls by external domain, by team, in the last 90 days" is the AI equivalent of a data flow map — useful for security reviews and compliance attestations.

**Feasibility:** High. A dedicated `/org/mcp` page analogous to the existing `/org/tools` page, plus an error-rate column, covers most of this.

---

### 3.4 Developer Skill Progression

**The opportunity:** Friction score and session shape are computed nightly but mostly surfaced as current snapshots. The temporal dimension is where the insight lives.

**What this data enables:**

- **Individual improvement curves**: does a developer's `friction_score` decline over 60 days? Does their session shape shift from `exploratory` to `implementation` on codebases they are learning? These are measurable signals of AI proficiency growth.
- **Onboarding acceleration**: new hire time-to-first-merged-PR with AI assistance vs. the historical baseline for the team. This is a concrete recruiting and onboarding argument for AI tooling investment.
- **AI skill adoption funnel**: `skill_name` invocation over time per user. Which users discover skills early? Which never adopt them? Informs whether training or discoverability is the bottleneck.
- **Subagent and MCP adoption as an advanced-user signal**: `subagent_type` invocations mark developers who are orchestrating AI, not just prompting it. This is a leading indicator of AI-native engineering practices.
- **Permission denial trends**: developers who get fewer denials over time are learning what the AI can and can't do. High sustained denial rates may indicate a UX or trust issue worth investigating.

**Feasibility:** Medium. Requires time-series views over user-level signals, which need careful UX design to avoid feeling like surveillance. The Phase 7 friction trend in `/me/insights` is implemented; team-level progression requires aggregation that preserves privacy.

> **Partially shipped (2026-06-30):** `/me/insights` now decomposes a developer's
> friction into its drivers (denials, tool errors, interrupts, early abandonment)
> and surfaces an actionable recommendation list (pre-approve denied tools,
> investigate error-prone tools / flaky MCP servers, tighten prompts when interrupts
> dominate). This is the individual coaching layer. A weekly median-friction trend
> for teams (`/team/[slug]`) and the org (`/org/dashboard`) now ships too, with
> per-bucket small-n suppression for privacy.
>
> **Shipped (temporal depth):** `/me/insights` now shows a per-user **weekly
> session-shape trend** (shape-shift over time — movement toward focused-edit as a
> proficiency signal), and `/org/dashboard` shows **cohort friction divergence** —
> median friction by first-seen-month cohort (tenure proxy, no HR data), small-n
> suppressed (≥3 devs / ≥5 scored sessions per cohort).

---

### 3.5 Code Quality & Risk Correlation

**The opportunity:** The PR rollup data contains both AI session characteristics and code outcome signals. Correlating them creates a quality signal that doesn't exist in any current tooling.

**What this data enables:**

- **Defect prediction**: join `session_pr_links` → `pull_requests` → bug tickets filed against the merged commit range (requires Jira/Linear integration). Do PRs from high-friction sessions have higher post-merge defect rates? If yes, that's a pre-merge intervention signal.
- **Revert pattern analysis**: `pull_requests.reverted_at` with session characteristics. Do reverted PRs cluster around specific session shapes, time-of-day patterns, or repos? This is the kind of analysis that typically requires a postmortem — here it is automatic.
- **CI failure correlation**: `pr_rollups.check_failures_count` (already captured) vs. session tool mix. Sessions that ran tests via Bash before merging should have fewer CI failures. Measurable.
- **Review burden from AI PRs**: `pr_rollups.lines_added` × `pull_requests.review_count` × time-to-merge. Are AI-assisted PRs larger, harder to review, and slower to merge? The data answers this without a survey.
- **Documentation coverage signal**: sessions heavy on `fs_read` without a corresponding transcript-level question pattern (via FTS) suggest the developer was navigating undocumented code — an implicit documentation gap detector.

**Feasibility:** Medium. The session and PR data is there. The bug-correlation join requires an external integration. The revert and CI analyses are pure internal joins and can ship without external dependencies.

---

### 3.6 Knowledge Gap Detection via Transcript Patterns

**The opportunity:** Transcripts are searched today as individual records. Aggregated at scale (without exposing individual content), they reveal organizational knowledge patterns.

**What this data enables:**

- **Documentation gap detection**: if 40 developers asked AI to explain the same module in the last quarter, that module has a documentation problem. Aggregate question clustering from `transcript_index` (FTS) can surface these without exposing individual conversations.
- **Onboarding pain points**: what do developers in their first 90 days ask AI most? That is precisely where onboarding docs are weakest — a direct signal that today requires surveys to discover.
- **Architecture decision gap**: "why is X implemented this way" questions recurring across the team = decisions that should have been captured in ADRs but weren't.
- **Repeated problem domains**: developers repeatedly asking AI about security, performance, or specific APIs = candidates for internal training, better tooling, or platform investment.

**Important constraint:** This analysis must operate on aggregate patterns, not individual transcripts, to maintain the trust model (see `DESIGN_DOC.md §8`). The unit of analysis is "how many sessions touched topic X" not "Alice asked about X."

**Feasibility:** Medium-High. The FTS index is already built. Aggregate topic clustering requires either a simple keyword taxonomy or a lightweight embedding model (the `embed-transcripts` job is scaffolded but gated in Phase 7). Keyword taxonomy is low-effort and sufficient for most use cases.

> **Shipped:** `/org/knowledge` surfaces aggregate topic reach (session + distinct-user counts per topic) via a fixed keyword taxonomy over the FTS index — visibility-scoped, with small-n suppression so no topic can re-identify an individual. Embedding-based clustering remains the (gated) upgrade path.

---

### 3.7 Security & Compliance

**The opportunity:** The platform already creates audit infrastructure that security and compliance teams typically can't get from developer tooling. Surfacing it explicitly unlocks a new buyer.

**What this data enables:**

- **AI data exposure audit**: what categories of tool calls occurred in sessions on sensitive repos (`tool_category` = `fs_read`, `web`, `exec` combined with repo tagging)?
- **Secret exposure monitoring**: the redaction pipeline already flags `[REDACTED:type]` hits and stores the redaction class set per transcript. A report of "these sessions contained secrets most frequently" is both a security signal and a developer training trigger.
- **Unauthorized external service access**: MCP calls to services not on an org-approved list — detectable from `mcp_server` events. A policy enforcement mode (alert or block on unapproved MCP servers) would be a natural extension.
- **Regulatory audit trail**: every privileged data access is audit-logged with actor, target, justification, IP, and timestamp. This is SOC 2 evidence that most developer tooling platforms don't produce.
- **Data exfiltration anomaly detection**: unusually large `tool_output_bytes` on `web` category tools in sensitive repos = a signal worth investigating. The events table supports this query today.

**Feasibility:** High for reporting. Medium for policy enforcement (requires a hook-side enforcement path, which is architecturally sound given the hook binary design). The audit log is already the best artifact in this space — it just needs a security-focused dashboard surface.

> **Shipped:** `/org/security` reports the data-flow surface from already-captured data — tool-category exposure, per-repo exec/network/write exposure, an external-MCP egress inventory, largest data movements (`tool_output_bytes`), a privileged-access audit summary, and **secret-exposure by redaction class**. The redaction classes detected at ship time are now persisted (`sessions.redaction_flags`, populated by the ingest transcript pipeline) and grouped into a per-class report — counts are forward-looking (no historical backfill). Policy enforcement (block on unapproved MCP servers) remains out of scope for the observe-only architecture.

---

### 3.8 Financial Planning & Vendor Strategy

**What this data enables:**

- **Spend forecasting**: session volume × cost-per-session trend → projected next month AI spend by team. Financeable at the team-budget level.
- **Cost allocation**: distribute AI costs to business units, products, or features. The session → PR → Jira chain enables this at feature granularity once the integration is built.
- **Negotiation leverage**: detailed usage data (model mix, volume by tier, growth rate) is exactly what vendor account managers want before a volume discount negotiation. Most orgs don't have it.
- **Multi-vendor comparison baseline**: the `agent_type` dimension was designed for this. Once Cursor or Copilot adapters exist, head-to-head cost and productivity comparison is available without any new data collection.
- **Budget enforcement**: Phase 9 alerts fire on spend spikes. The next step is pre-authorized budget caps per team with automatic notification before overage — not just after.

**Feasibility:** High for forecasting and allocation (data is there, UI is the work). The multi-vendor comparison requires adapter work (Phase 8 proved the pattern with `opencode` and `codex`).

> **Shipped:** `/org/dashboard` now carries a spend forecast — trailing-7d run-rate and month-to-date projections, per-team run-rate, and a comparison against a configured `budget_threshold` alert rule (warn/critical at the same 0.8/1.0 ratios the alert engine uses). The `budget_threshold` rule itself is already evaluated by the ingest alert engine, so budget enforcement is now proactive (projection before overage), not just reactive spend-spike alerts.

> **Partially shipped (2026-06-30):** `/org/agents` now has an agent-comparison table
> (sessions, total + avg cost, median friction, tool error rate, tokens by
> `agent_type`), so any agents already reporting telemetry are compared head-to-head.
> Adding Cursor/Copilot to the comparison still needs their adapters — no telemetry
> contract exists for those tools yet.

---

### 3.9 Developer Experience Research (Audience B)

**The opportunity:** The `investigator` role with time-boxed grants (Phase 9) enables something most DX teams can't do today — evidence-based, privacy-preserving session analysis at scale.

**What this data enables:**

- **Workflow friction mapping**: where do developers interrupt sessions? What tool were they running? What was the session shape at the time? This is UX research data that previously required recording screens or running interviews.
- **Skill quality feedback loop**: skills with high invocation but high downstream friction → the skill is being used but isn't working well. Skill authors currently have no feedback loop; this creates one.
- **Tool deprecation signal**: a tool with declining call volume and rising error rates is a deprecation candidate. Data-driven, not political.
- **AI capability gap detection**: repeated tool errors or permission denials on a specific task type reveal where AI falls short — input for vendor feedback, internal tooling, or operator configuration.
- **Adoption intervention targeting**: developers with zero sessions in the last 30 days despite having the hook installed = adoption blockers worth investigating individually (with consent).

**Feasibility:** Medium. The grant-scoped investigator access is implemented (Phase 9). The research surface on top of it (session sampling UI, topic clustering, aggregate pattern views) is the next layer. Critically, the access model protects developer trust while enabling the research.

---

## 4. Prioritized Opportunities

Ranked by **impact-to-effort**, given the current data model and what is already built.

| # | Opportunity | Impact | Effort | Data ready? | What's missing |
|---|---|---|---|---|---|
| 1 | **Model cost optimization** (routing + cache efficiency guidance) | High — potential 30–50% spend reduction | Low | ✅ Per-turn model + cache tokens captured | 🟡 Price-precise routing recommendations + cache guidance on `/org/models`, plus a `routing_waste` alert; automated routing *policy* enforcement (hook-side) still open |
| 2 | **MCP portfolio dashboard** (utilization, error rate, SLO) | Medium-High — deprecate waste, surface risk | Low | ✅ `mcp_server` + `tool_exit_status` fully captured | `/org/mcp` page; error-rate column |
| 3 | **Outcome-based ROI** (cost-per-PR trend, revert correlation, CI correlation) | High — executive-level justification | Medium | ✅ PR rollups, revert flags, CI failures all captured | 🟡 Shipped at `/org/roi` (internal joins); external business-value join still deferred |
| 4 | **Developer skill progression** (friction trend, shape shift over time) | Medium-High — retention, training, onboarding | Medium | ✅ Friction + shape computed nightly | 🟡 `/me/insights` friction breakdown + recommendations + per-user weekly shape-shift trend; team/org weekly friction trends; org cohort friction divergence by first-seen month. Longitudinal pre/post-adoption still needs baseline data |
| 5 | **Budget forecasting & cost allocation** (by team, project, Jira epic) | High — replaces spreadsheet finance | Medium | ✅ Session cost + PR rollup captured | 🟡 Spend forecast (run-rate + budget-rule comparison) shipped on `/org/dashboard`; Jira-epic cost allocation on `/org/roi`; external business-value join still deferred |
| 6 | **Security data exposure reporting** (sensitive repos, secret hits, MCP egress) | High — compliance buyer | Medium | ✅ Tool categories, redaction metadata, audit log | ✅ `/org/security` shipped — category/repo exposure, MCP egress, large data movements, audit summary, and per-redaction-class secret hits (`sessions.redaction_flags`, forward-looking) |
| 7 | **Knowledge gap detection** (aggregate transcript topic clustering) | Medium — DX and documentation | Medium-High | ✅ FTS index built | 🟡 `/org/knowledge` shipped (keyword-taxonomy topic reach, small-n suppressed); embedding-based clustering still the upgrade path |
| 8 | **Code quality correlation** (revert + defect rate by session characteristics) | High — if bug rate correlation holds | High | ⚠️ Internal PR data ready; bug join needs Jira/Linear | External integration + statistical analysis |
| 9 | **Multi-tool comparison** (Claude vs Cursor vs Copilot) | High — procurement decisions | High | ✅ `agent_type` schema ready; adapters exist for `opencode`, `codex` | 🟡 Comparison table shipped at `/org/agents` (cost/friction/error-rate by `agent_type`); Cursor/Copilot adapters still needed |

---

## 5. Cross-Cutting Considerations

### Trust is the gating constraint, not data

Every opportunity above is constrained by developer trust, not by data availability. The privacy defaults (`share_transcripts_with_team = false`) and audit log visibility are the foundation on which all of these analyses rest. Any expansion of analysis scope — especially toward performance management or individual behavior tracking — risks destroying adoption, which destroys the data, which destroys all of these benefits.

**Rule:** every new analysis surface must first answer "what does the individual developer get from this?" If the answer is nothing, reconsider whether to build it or how to present it.

### The effectiveness caveat (from §10.6 of the design doc)

Cost-per-session and similar metrics are directionally useful but precisely misleading without outcome context. A $40 session unblocking a senior engineer for two days is cheaper than a $5 session producing code that gets reverted. Always pair cost metrics with outcome signals (did the PR merge? was it reverted? did a bug follow?). This is a presentation discipline that must be enforced in every new dashboard.

### Aggregate-first, individual-second

Most of the highest-value insights come from aggregate patterns, not individual sessions. Build aggregate views first; individual drill-down is a separate access decision that should require explicit consent or a grant-scoped investigation path.

---

## 6. Future Directions Not in Current Scope

These require external data sources or significant new infrastructure:

- **Longitudinal pre/post AI adoption analysis**: requires baseline productivity data (PR velocity, cycle time) from before hook rollout. Git history can provide this retroactively for repos with long history.
- **Cohort analysis by hire date or role**: does AI effectiveness diverge by seniority over time? Requires HR data join (GitHub login → employee record).
- **Public API for internal tool integration**: allow engineering dashboards, finance systems, or data warehouses to query rollups via authenticated API. Natural evolution once the data model stabilizes.
- **IDE telemetry joins**: overlap between AI session context and IDE usage (file open/close events, test runs) would enrich session shapes significantly. Requires a separate telemetry stream.
- **Open-source spin-off**: the ingest API and data model are generic enough to be useful to any org running Claude Code. A self-hosted open-source variant with enterprise features as a commercial layer is a natural product path.

---

*Document generated from platform analysis on 2026-06-25. See [`DESIGN_DOC.md`](DESIGN_DOC.md) for the canonical architecture and [`PLAN.md`](PLAN.md) for the implementation roadmap.*
