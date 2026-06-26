# Phase 5 — Effectiveness signals (roadmap)

**Status**: Fully decomposed into P5-001 … P5-006; all Phase 5 tasks are `done`. See [`INDEX.md`](./INDEX.md) for task-level status.

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
- **P5-006 Multi-agent readiness**
  Widen the schema and document cross-cutting decisions so the platform can accept agents beyond Claude Code without a breaking migration. Real second/third adapters and per-agent price tables moved to Phase 8.

## P5-006 — Multi-agent decoupling (detail)

> Captured from a coupling audit (PR #31). At that point the platform was
> **single-agent on a multi-agent-ready spine**. The data model, ingest API, transcript storage,
> PR correlation, auth, redaction, and dashboards are agent-neutral in their logic;
> the coupling lives in the schema/event-type layer, a few Claude-shaped columns, and
> the hook (which is — correctly — a Claude Code adapter). This section enumerates the
> work needed to accept a second agent. Most of it was a prerequisite for *any* second agent,
> and Phase 8 now implements the concrete adapter/price-table pieces. Tracks `DESIGN_DOC.md`
> §2.4 (Multi-Agent Extensibility) and §15 (Cross-tool unification).

**Already decoupled (no work needed):**

- `agent_type` dimension on both `events` and `sessions` (indexed, defaults `claude_code`).
- Ingest is agent-neutral: the events endpoint, transcript pipeline, and session upsert
  store/forward `agent_type` without branching on it.
- GitHub/PR correlation, auth, redaction, and the web read layer are agent-agnostic.
  Per-agent price tables were added later in P8-002 and are now `done`.
- `getSessionModelBreakdown` already derives per-model usage generically from the events
  firehose (not from the Claude-shaped session columns).

**Decoupling tasks:**

- [x] **Widen the agent enums.** `AgentTypeSchema` and the Prisma `AgentType` enum now cover
  `CLAUDE_CODE`, `CURSOR`, `AIDER`, `COPILOT`, `CODEX`, `WINDSURF`, and `OPENCODE`; the
  schema package uses the corresponding lower-case wire values.
- [x] **Generalize the event-type taxonomy.** The event schema is a discriminated union over
  shared lifecycle/tool events, and adapter-specific hook kinds are translated in
  `apps/hook/src/adapters/*`.
- [x] **Retire the Claude-shaped session columns.** `sessions.opus_turns` /
  `sonnet_turns` / `haiku_turns` dropped (were never populated; per-model breakdown
  now served by the events-firehose query). `claude_code_version` retained as
  `claudeCodeVersion` (useful fingerprint when agent is claude_code).
- [x] **Implement the `<agent>:<tool>` tool-naming convention** (DESIGN §2.4). Completed in
  P8-001 and now `done`.
- [x] **Per-agent price tables.** Completed in P8-002 and now `done`.
- [x] **Factor the hook into an adapter seam.** Completed in P8-003/P8-004 and now
  `done`.
- [x] **De-Claude-ify user-facing copy.** Completed in P8-005 and now `done`.

**Sequencing:** P5-006 delivered schema/readiness work. Phase 8 supersedes the deferred
tool-naming, per-agent price-table, adapter seam, and de-Claude-ification items; those tasks
are `done` in `tasks/INDEX.md`.

## Exit criteria

- [ ] At least one effectiveness signal cited in a real promo packet or planning doc.
- [ ] Friction score correlates with self-reported "bad sessions" in a small survey (n ≥ 20).
- [ ] Clusters stable across retraining runs (label assignments don't churn week-to-week).
