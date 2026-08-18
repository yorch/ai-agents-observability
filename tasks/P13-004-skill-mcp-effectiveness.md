---
id: P13-004
title: Skill & MCP effectiveness scoring
phase: 13
workstream: B
status: review
owner: claude
depends_on: [P13-001, P13-003]
blocks: []
estimate: M
---

## Goal

Score skills and MCP servers, not just count them: for each `skill_name` and
`mcp_server`, relate invocation volume to downstream friction, tool-error rate, and PR
outcome, stored as `scores` rows against `subject_type: skill` / `mcp_server` and
surfaced on the existing `/org/skills` and `/org/mcp` pages.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§3.4 (R9). `DESIGN_DOC.md` §15 already names the gap: "Skills with high invocation but
low downstream tool success could be flagged for revision. Skill authors get a
dashboard." `OPPORTUNITIES.md` §3.3 says the same for MCP servers — "treat each MCP
server as a service with its own SLO (success rate, latency)" — and §3.9 frames the
skill feedback loop as a DX-research surface.

Today `/org/skills`, `/team/[slug]/skills`, `/org/mcp`, and `/team/[slug]/mcp` exist
but report **usage**, not quality. The data for quality is already captured:
`events.skill_name`, `mcp_server`/`mcp_tool`, `tool_exit_status`, `tool_duration_ms`,
plus the session-level friction and PR outcomes those events roll up into.

This is the one workstream-B task whose output is directly actionable by a human: a
skill author or MCP owner can fix the thing being measured.

## Acceptance criteria

- [x] Per skill and per MCP server, a scored profile over a window:
      invocation count, distinct users, tool-error rate, p95 `tool_duration_ms`
      (MCP), median friction of sessions that invoked it vs sessions that did not,
      and the merge/revert/CI-clean rate of linked PRs.
- [x] The friction and outcome comparisons are **volume-gated and significance-tested**
      using the existing P11-004 machinery — no bare "skill X is worse" claim on a
      handful of sessions.
- [x] Every comparison is presented as association, never causation. A skill invoked
      mostly on hard problems will look bad; the surface must say so in copy, and the
      task is not done if it reads as a verdict.
- [x] Scores are written as `scores` rows keyed by `subject_type` `skill` /
      `mcp_server`, so trends over time are queryable and P13-006 can validate them.
- [x] Surfaced on `/org/skills`, `/org/skills/[kind]/[name]`, and `/org/mcp`;
      the team equivalents inherit the same component. Visibility-scoped exactly like
      the pages they extend, with small-n suppression.
- [x] A skill or MCP server with zero invocations in the window is reported as a
      deprecation candidate rather than omitted.
- [x] MCP error-rate reporting distinguishes *server unavailable* from *tool returned
      an error*, where the exit status allows — they need different owners.
- [x] Agent-neutral: `<agent>:<tool>` naming is respected and no scorer assumes a
      single agent's skill model.

## Implementation notes

- Reuse `apps/web/src/lib/quality-queries.ts` (Fisher's exact from P11-004) rather
  than writing a second significance path.
- The "sessions that invoked it vs sessions that did not" comparison is the whole
  value and the whole risk. Match on something — repo, shape label, or both — or the
  comparison is dominated by task difficulty. Document the matching in the panel copy.
- Skills and MCP servers are org-level subjects, not per-developer ones. This keeps
  the surface aggregate-first (`OPPORTUNITIES.md` §5) with no per-dev drill-down: the
  question is "is this skill good," never "is this developer good at using it."
- Reuse the deprecation-candidate framing already sketched in `OPPORTUNITIES.md`
  §3.3 for zero-invocation servers.

## Files touched

- `apps/web/src/lib/` (a skill/MCP scoring query module + test)
- `apps/web/src/app/org/skills/page.tsx`, `apps/web/src/app/org/skills/[kind]/[name]/page.tsx`
- `apps/web/src/app/org/mcp/page.tsx`
- `apps/web/src/app/team/[slug]/skills/page.tsx`, `apps/web/src/app/team/[slug]/mcp/page.tsx`
- `apps/ingest/src/jobs/` (scheduled computation, if not computed on read)

## Out of scope

- A per-developer view of "which skills you use badly." Aggregate-first; the subject
  of this task is the skill, not the person.
- Automatically disabling or recommending removal of a skill or MCP server. Report
  the signal; the decision is human.
- Blocking unapproved MCP servers — enforcement remains out of scope for an
  observe-only platform (`OPPORTUNITIES.md` §3.7).
- Judging skill *content* (reading the skill file and rating it). That is an
  agent-config harness concern, not a telemetry one.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test
bun run --cwd apps/web typecheck
bun run check
bun run typecheck
bun run build
bun run test
```
