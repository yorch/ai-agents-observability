# Phase 5 — Effectiveness signals (roadmap)

**Trigger to decompose**: Phase 4 exit criteria met, or earlier if a specific signal becomes strategically urgent.

## Goal recap

Move from "what happened" to "did it work". Friction score, session-shape clusters, revert detection, optional Jira/Checks correlation. Cited in real decision-making (promo, planning), not just dashboards.

See `DESIGN_DOC.md` §12.5.

## Sketched tasks

- **P5-001 Friction score**
  Composite metric per session: weighted sum of retries, denials, interrupts, abandonment. Surfaced on `/me/sessions` and team views. Tunable weights, version-pinned.
- **P5-002 Session-shape clustering**
  Per-session tool histogram vector → k-means → label (exploratory / focused-edit / debugging / multi-tool / …). Materialized into `Session.shape_label`. Cluster definitions documented + reproducible.
- **P5-003 Revert detection**
  Use `git log --follow` over PR commits in `pull_requests`. Flag if commit reverted within N days. Surface on `/me/prs`.
- **P5-004 Jira integration (gated on §13 Q6)**
  If S1 has a branch→Jira convention, ladder `PRRollup` to feature-level. Read-only Jira API; cache aggressively.
- **P5-005 GitHub Checks correlation**
  Correlate session activity with check failures on the related PR. "Sessions that produced check-failing code" surface.
- **P5-006 Multi-agent (`agent_type=cursor`) adapter**
  If demand: a second-agent adapter (e.g. Cursor) that emits compatible events. Spike first; full integration only if dogfooded. See the decoupling breakdown below.

## P5-006 — Multi-agent decoupling (detail)

> Captured from a coupling audit (PR #31). The platform is **single-agent today on a
> multi-agent-ready spine**. The data model, ingest API, transcript storage,
> PR correlation, auth, redaction, and dashboards are agent-neutral in their logic;
> the coupling lives in the schema/event-type layer, a few Claude-shaped columns, and
> the hook (which is — correctly — a Claude Code adapter). This section enumerates the
> work to accept a second agent. Most of it is a prerequisite for *any* second agent,
> so it can land ahead of an actual Cursor/Aider integration. Tracks `DESIGN_DOC.md`
> §2.4 (Multi-Agent Extensibility) and §15 (Cross-tool unification).

**Already decoupled (no work needed):**

- `agent_type` dimension on both `events` and `sessions` (indexed, defaults `claude_code`).
- Ingest is agent-neutral: the events endpoint, transcript pipeline, and session upsert
  store/forward `agent_type` without branching on it.
- Per-agent price-table lookup is keyed by model string; GitHub/PR correlation, auth,
  redaction, and the web read layer are agent-agnostic.
- `getSessionModelBreakdown` already derives per-model usage generically from the events
  firehose (not from the Claude-shaped session columns).

**Decoupling tasks:**

- [ ] **Widen the agent enums.** `AgentTypeSchema` (`packages/schemas/src/event.ts`) is
  `z.enum(['claude-code'])` and the Prisma `AgentType` enum (`packages/db/prisma/schema.prisma`)
  has only `claude_code`. Add the second agent to both (+ migration). Note the existing
  hyphen-vs-underscore normalization (`agent_type.replaceAll('-', '_')` in ingest) — fold
  into one canonical spelling while here.
- [ ] **Generalize the event-type taxonomy.** `EventTypeSchema` is exactly Claude Code's
  hook lifecycle (`SessionStart`, `PreToolUse`, `PreCompact`, `SubagentStop`, …). Decide
  whether a second agent maps its lifecycle onto these names or needs additional members;
  document the mapping. The hook→event mapping (`apps/hook/src/lib/payload.ts`
  `HOOK_KIND_TO_EVENT_TYPE`) is the per-adapter translation point.
- [ ] **Retire the Claude-shaped session columns.** `sessions.opus_turns` /
  `sonnet_turns` / `haiku_turns` and `claude_code_version` don't generalize across vendors
  (and the turn columns are never populated today). Replace with a generic per-model
  breakdown (the events-firehose query already exists) and rely on `agent_version`.
- [ ] **Implement the `<agent>:<tool>` tool-naming convention** (DESIGN §2.4). Today
  `tool_name` is stored raw (`"Edit"`) in `insert-events.ts` with no agent prefix, so the
  documented collision-avoidance mechanism is not actually built. Decide: prefix on write,
  or always disambiguate by `(agent_type, tool_name)` at query time.
- [ ] **Per-agent price tables.** Generalize `price-table.v1.json` →
  `price-table.<agent>.v1.json` and key cost lookup on `(agent_type, model)` so a
  non-Anthropic agent's models price correctly. (Unknown-model $0 is already logged.)
- [ ] **Factor the hook into an adapter seam.** The queue, flusher, shipper, retry/abandon
  logic, and transcript machinery in `apps/hook` are agent-neutral; only `payload.ts`,
  the `~/.claude` paths, and the install/uninstall commands are Claude-specific. Extract an
  adapter interface so a second adapter reuses the transport without forking it.
- [ ] **De-Claude-ify user-facing copy.** Drive labels from `agent_type` rather than
  hard-coding "Claude" — e.g. the PR-bot "🤖 Claude Code summary" comment
  (`apps/github-app/src/lib/pr-comment.ts`) and `/me` dashboard copy.

**Sequencing:** the enum + event-type + tool-naming + price-table items are the foundation
and can ship as one "multi-agent readiness" PR with no behavior change for Claude Code
(default `agent_type` keeps everything working). The adapter seam + a real second adapter is
the follow-on, gated on actual demand / dogfooding.

## Exit criteria

- [ ] At least one effectiveness signal cited in a real promo packet or planning doc.
- [ ] Friction score correlates with self-reported "bad sessions" in a small survey (n ≥ 20).
- [ ] Clusters stable across retraining runs (label assignments don't churn week-to-week).
