---
id: P8-005
title: De-Claude-ify user-facing copy
phase: 8
workstream: E
status: review
owner: claude
depends_on: [P5-006]
blocks: []
estimate: S
---

## Goal

Drive all user-facing agent labels from `agent_type` instead of hard-coding "Claude" so that a multi-agent org sees correct agent names everywhere, and a single-agent `claude_code` deployment is visually unchanged.

## Context

Several surfaces emit agent labels from string literals rather than from `agent_type`:

- `apps/github-app/src/lib/pr-comment.ts` — the PR-bot comment header reads "🤖 Claude Code summary" regardless of which agent generated the session.
- `apps/web/src/app/me/page.tsx` and components under `apps/web/src/components/` — the /me dashboard uses "Claude" in copy, headings, and empty-state text.

DESIGN_DOC.md §2.4 names "My Agents" as a deliberately plural construct from day one; the copy should reflect that. The fix is a display-name helper (`agentDisplayName(agentType: AgentType): string`) that maps enum values to human-readable labels (`claude_code` → "Claude Code", `opencode` → "opencode", `cursor` → "Cursor", etc.) and is called at every render site.

Sessions can involve multiple agent types (e.g. a PR correlation that spans a claude_code session and an opencode session). The PR-bot comment header should list all distinct agents, not assume one.

## Acceptance criteria

- [ ] A `agentDisplayName(agentType: AgentType): string` helper exists (in `apps/web/src/lib/` or `packages/schemas/`) and maps every `AgentType` enum member to a human-readable label.
- [ ] The PR-bot comment header in `apps/github-app/src/lib/pr-comment.ts` derives the agent label(s) from the session's `agent_type`; a session with `agent_type = 'opencode'` produces "opencode" in the header, not "Claude Code".
- [ ] For a PR involving multiple agents, the comment header lists all distinct agents (e.g. "Claude Code, opencode").
- [ ] The /me dashboard (`apps/web/src/app/me/page.tsx`) and its sub-components use `agentDisplayName` rather than hard-coded "Claude" strings for agent references.
- [ ] A single-agent `claude_code` deployment produces output identical to today (no visible change).
- [ ] `bun run typecheck` passes; `bun run check` passes.

## Implementation notes

The display-name map is a simple `Record<AgentType, string>`. Put it in `packages/schemas` if it needs to be shared by both `apps/web` and `apps/github-app`; otherwise a local util in each app is fine if they don't diverge.

Audit `apps/web/src/components/` for any remaining "Claude" literals that are agent labels (not product names, documentation, or code references — those are fine).

## Files touched

- `apps/github-app/src/lib/pr-comment.ts`
- `apps/web/src/app/me/page.tsx`
- `apps/web/src/components/` (any components with hard-coded agent-label strings)
- `packages/schemas/src/agent-display.ts` (new, if shared helper) or `apps/web/src/lib/agent-display.ts`

## Out of scope

- Internationalisation / localisation of agent names.
- Renaming the "My Agents" product copy — that name is intentional and stays.
- Any copy that refers to Claude as an LLM (model names, documentation prose) rather than as an agent label.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@app/web' test
bun --filter '@app/github-app' test

# Manual check:
# 1. Seed a session with agent_type='opencode'
# 2. Trigger the PR-bot comment flow — confirm header does not say "Claude Code"
# 3. Visit /me — confirm no hard-coded "Claude" agent labels appear for opencode sessions
```

> **Verification status (review):** `agent-display.test.ts` (5) + `pr-comment.test.ts` (7) **pass
> locally**; biome clean. `agentDisplayName` + `multiAgentLabels` added to `packages/schemas`.
> The PR-bot header was already agent-neutral ("AI agent summary"); it now appends the distinct
> contributing agents — suppressed for the single-claude_code case (header unchanged), shown for
> a single non-Claude agent ("(opencode)") or multiple ("(Claude Code, opencode)"). The handler
> derives distinct agents from the rollup's contributing sessions. `/me` empty-state copy is
> helper-driven (DEFAULT_AGENT_TYPE → "Claude Code", identical output).
>
> **Scope note:** onboarding/install prose ("install the hook … run Claude Code") is product copy
> for the primary agent and left as-is per the out-of-scope note + the "single-agent unchanged"
> criterion. typecheck runs in CI (Prisma client egress-blocked locally).
