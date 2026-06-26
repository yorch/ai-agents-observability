# Fix Claude Code Hook settings.json Snippet Format — Implementation Plan

Spec: docs/specs/2026-06-25-fix-hook-settings-snippet-format.md
Workspace: worktree: .claude/worktrees/fix-hook-settings-snippet-format
Jira: N/A

## Tasks

### Task 1: Write failing test for renderSnippet

**What**: Create `apps/hook/src/adapters/claude-code.test.ts`. The test calls `renderSnippet` (exported for testing), parses the JSON output, and asserts: (a) the top-level key is `"hooks"`, (b) all 8 keys are PascalCase (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`, `PreCompact`, `SubagentStop`, `Notification`) with no kebab-case keys present, (c) each value is an array of length 1 containing `{ hooks: [{ type: "command", command: "<bin> hook <kind>" }] }`. This test fails on the current implementation (RED phase).
**Files**: `apps/hook/src/adapters/claude-code.test.ts` (new)
**Depends on**: none
**Verify**: `bun test apps/hook/src/adapters/claude-code.test.ts` — test exists and fails (RED confirmed)

### Task 2: Fix renderSnippet to make the test pass

**What**: In `apps/hook/src/adapters/claude-code.ts`, add a `HOOK_KIND_TO_EVENT_NAME` constant mapping each `HookKind` to its PascalCase Claude Code settings.json key. Rewrite `renderSnippet` to iterate `HOOK_KINDS`, look up the PascalCase name, and build `{ hooks: { [PascalCaseName]: [{ hooks: [{ type: "command", command: "${bin} hook ${kind}" }] }] } }`. Export `renderSnippet` (or a testable variant) so Task 1's test can import it directly.
**Files**: `apps/hook/src/adapters/claude-code.ts`
**Depends on**: Task 1
**Verify**: `bun test apps/hook/src/adapters/claude-code.test.ts` — all assertions pass (GREEN). `bun run typecheck --cwd apps/hook` — no type errors. `bun run check` — lint clean.
