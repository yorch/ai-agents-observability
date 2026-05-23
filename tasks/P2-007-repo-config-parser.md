---
id: P2-007
title: .claude-telemetry.yml repo config parser
phase: 2
workstream: C
status: ready
owner: null
depends_on: []
blocks: [P2-006]
estimate: S
---

## Goal

A versioned Zod schema and parser for `.claude-telemetry.yml` — the per-repo opt-in config file. Zero external dependencies beyond Zod 4.

## Context

- `DESIGN_DOC.md` §7.4 — opt-in is per repo via this file at the repo root.
- `PLAN.md` §1 — "Opt-in per repo via `.claude-telemetry.yml`".
- Lives in `packages/schemas` alongside the existing event and session-context schemas.

## Acceptance criteria

- [ ] `RepoConfigSchema` (Zod v4) exported from `packages/schemas` that validates:
  ```yaml
  # .claude-telemetry.yml
  version: 1                   # required; must be 1 for this schema
  pr_bot:
    enabled: true              # default: false
    include_cost: true         # default: true — show cost line in comment
    include_tool_counts: true  # default: true — show tool count line
    include_contributors: true # default: true — show contributor count
  ```
- [ ] All fields except `version` are optional with documented defaults.
- [ ] `parseRepoConfig(yamlString: string): RepoConfig | null` exported — returns `null` on parse failure (missing file, invalid YAML, invalid schema) rather than throwing. Callers treat `null` as "opted out".
- [ ] Uses `js-yaml` (add `"js-yaml": "4.1.0"` + `"@types/js-yaml": "4.0.9"` to root catalog) for YAML parsing. Zod validates the parsed object.
- [ ] Unknown top-level keys are stripped (use `z.looseObject` for forward compatibility).
- [ ] Test cases:
  - Valid minimal file (only `version: 1`).
  - Valid full file.
  - `enabled: false` → returns config with `pr_bot.enabled = false`.
  - Invalid YAML → `null`.
  - Wrong `version` number → `null` (treat as unsupported; don't try to parse).
  - Empty file → `null`.
  - Extra unknown keys → parsed and stripped.

## Implementation notes

- Zod v4 `z.looseObject` replaces `z.object(...).passthrough()`. Use it for the top-level schema and `pr_bot` sub-object.
- `version` check: `z.literal(1)` on the version field. Future schema versions get their own Zod schema and a discriminator.
- Keep `parseRepoConfig` pure (no I/O). The file fetching lives in P2-006.

## Files touched

- `packages/schemas/src/repo-config.ts` (new)
- `packages/schemas/src/index.ts` (re-export)
- `packages/schemas/test/repo-config.test.ts` (new)
- `package.json` (add `js-yaml` + `@types/js-yaml` to catalog)

## Out of scope

- Fetching the file from GitHub (P2-006).
- Per-user masking preferences in the config (Phase 3).
- Multi-version migration (just return null for unknown versions for now).

## Verification

```bash
bun --filter '@ai-agents-observability/schemas' test
```
