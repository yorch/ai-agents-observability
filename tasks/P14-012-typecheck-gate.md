---
id: P14-012
title: Bring the test directories inside the typecheck gate
phase: 14
workstream: A
status: done
owner: claude
depends_on: []
blocks: []
estimate: M
---

## Goal

`bun run typecheck` actually checks every test file in the repo. Before this
task it reported 14/14 workspaces green while never looking at **80 of the
repo's 136 test files**.

## Context

Every workspace set `"include": ["src/**/*"]`. `include` is a whitelist: a file
outside it is not *checked and passing*, it is **invisible to tsc**. Tests
co-located under `src/` were checked; tests in a sibling `test/` directory were
not. Vitest transpiles without typechecking, so both gates went green.

Proven directly. Appending

```ts
const __gap_probe: number = 'definitely not a number';
export { __gap_probe };
```

to `apps/ingest/test/alert-email.test.ts` and running
`bun run --cwd apps/ingest typecheck` exited **0**.

The gap, at the time of the fix:

| workspace | in `test/` (unchecked) | in `src/` (checked) |
|---|---|---|
| `apps/ingest` | **34** | 1 |
| `apps/web` | **27** | 3 |
| `apps/github-app` | 5 | 5 |
| `packages/auth` | 4 | 0 |
| `packages/db` | 4 | 1 |
| `packages/schemas` | 3 | 14 |
| `packages/github` | 2 | 0 |
| `packages/redaction` | 1 | 0 |
| `apps/hook` | 0 | 32 |
| **total** | **80** | **56** |

Found when [`P14-011`](./P14-011-shared-attribution.md) moved one test file from
`apps/ingest/test/` into `packages/schemas/src/` and it immediately needed an
annotation it had never needed.

## What the gate was hiding

Eight workspaces widened; **111 diagnostics** fell out. Six were real drifts — a
fixture or a test double describing a shape the code no longer produces.

### 1. `apps/ingest` — `AppDeps.s3` missing from two suites' app

`AppDeps.s3` is required and `src/index.ts` always supplies it, but
`test/health.test.ts` and `test/auth.test.ts` built `AppDeps` without it.
`createApp` passes `deps.s3` straight into `transcriptsRouter`, so the app those
two files construct has its transcript routes wired to `undefined`. Neither file
requests a transcript route today, so nothing failed — but any transcript
coverage added to them would have died on a dependency production cannot be
missing. Both now build on the existing complete `makeTestDeps()`.

### 2. `apps/ingest` — a `Config` thirteen required fields short

The same two files declared a `Config` missing `anthropic_base_url`,
`app_base_url`, `billing_reconciliation_enabled`, `jira_project_keys`, the four
`judge_*` knobs, `org_max_retention_days`, `semantic_search_enabled`,
`smtp_port`, `smtp_secure` and `transcript_retention_days`. Only the first
mismatch — `log_level: 'silent'`, a level the config enum does not have — would
have surfaced, and it surfaced to nobody. A new `makeTestConfig()` in
`test/helpers.ts` spells the required set out once.

### 3. `apps/ingest` — a db double that could not have exercised the run_kind probe

`test/session-aggregation.test.ts`'s `makeDb()` had no `$queryRaw`, which
`RawDb` requires and `upsertSessions` calls for the P13-002 run_kind escalation
probe. Every batch in that file is interactive, so the probe never fires — had
one carried a CI/EVAL claim the double would have thrown `$queryRaw is not a
function`. The escalation path *is* covered, by `test/run-kind-merge.test.ts`
whose double provides it; but this file could not have covered it and nothing
said so.

The same file's three tool fixtures were missing `action` (P13-003),
`target_hash` and `tool_use_id` (P14-006) — fields the tool schema grew after
the fixtures were written. `upsertSessions` reads none of them, so no assertion
moved, but the fixtures described a tool row no adapter produces.

### 4. `apps/github-app` — config fixtures three fields behind the schema

`test/webhooks.test.ts`, `test/ghes.integration.test.ts` and
`test/admin-health.test.ts` all built a `Config` without
`commit_link_grace_hours`, `jira_project_keys` or `pr_link_lookback_days`.
`test/ghes.integration.test.ts` drives the full `pull_request` handler, so it has
been calling `getJiraProjectAllowlist(db, undefined)` and
`backfillPRLinks(…, { lookbackDays: undefined })`. Both consumers default
internally, so no assertion was wrong — but the Jira-allowlist and PR-lookback
windows those tests appear to cover were exercised on library defaults, not on
the configured values. The fixtures now carry all three and are annotated
`: Config` so the next addition fails at the literal.

### 5. `apps/web` — a GitHub team role the API never sends

`test/sync-login-teams.test.ts` built its membership fixture with
`role: 'MEMBER'`. GitHub's `/user/teams` endpoint reports lowercase
`'member'` / `'maintainer'`, which is what the type says and what
`src/lib/sync-login-teams.ts` branches on (`m.role === 'maintainer'`). Both
spellings miss the maintainer branch and land on `'MEMBER'`, so the "no login
downgrade" assertion still held — but the maintainer branch was unreachable
from this fixture, and a future test written as
`membership({ role: 'MAINTAINER' })` would have silently asserted the member
path.

### 6. `apps/web` — a `ToolPerfRow` fixture four fields behind P14-004

`test/recommendations.test.ts`'s `toolPerf()` omitted `attributedCostUsd`,
`downstreamCostUsd`, `avgInputBytes` and `avgOutputBytes`.
`buildRecommendations` reads only the call/denial/error counters off these rows,
so nothing moved — but any cost read through this fixture would have seen
`undefined`, and `addNullable(null, undefined)` returns `undefined`, which
survives the `!== null` candidate filter and then fails the `>=` comparison. A
cost-based tool tip exercised through this fixture would silently produce no
recommendation.

### Per-workspace error counts

Counts are tsc diagnostics, not output lines — several carry multi-line
explanations (`apps/ingest`'s 59 diagnostics print as 114 lines).

| workspace | diagnostics | attributable to a real drift | mechanical |
|---|---|---|---|
| `apps/ingest` | 59 | 17 | 42 |
| `packages/auth` | 16 | 0 | 16 |
| `apps/web` | 14 | 3 | 11 |
| `apps/github-app` | 13 | 10 | 3 |
| `packages/redaction` | 9 | 0 | 9 (missing `@types/node`) |
| `packages/db` | 0 | — | — |
| `packages/github` | 0 | — | — |
| `packages/schemas` | 0 | — | — |
| **total** | **111** | **30** | **81** |

The mechanical bulk: 24 imports carrying an explicit `.ts` extension (TS5097),
9 `mock.calls[0][0]` under `noUncheckedIndexedAccess`, and deliberately partial
Prisma doubles. Nothing was silenced — no `@ts-nocheck`, no `as any`, no
narrowed `include`, no `skipLibCheck` widening, no exclusion list.

## Why `rootDir` moved

`rootDir` was `"src"` everywhere, and tsc refuses a file outside it (TS6059)
even under `--noEmit`. It moves to `"."`. That is safe because **no workspace
emits with tsc**: every package exports `./src/index.ts` directly, the three
servers build with `bun build … --outdir dist`, `apps/web` uses `next build`,
and `packages/db`'s build is `prisma generate`. `outDir`/`rootDir` in these
configs are check-only. Confirmed by rebuilding with `turbo run build --force`
and diffing the emitted layout — `apps/ingest/dist/index.js`,
`apps/github-app/dist/index.js`, `apps/hook/dist/claude-telemetry` and
`apps/web/.next/standalone/` are byte-for-byte the same paths as before.

## Acceptance criteria

- [x] Every workspace with a `test/` directory includes it in `include`.
- [x] `bun run check` → `typecheck` → `build` → `test` all pass.
- [x] The probe (`const p: number = 'no'` appended to a `test/` file) now
      **fails** typecheck in `apps/ingest`, `apps/web`, `apps/github-app`,
      `packages/auth` and `packages/schemas`. Before the change all five exited 0.
- [x] Emitted build layout unchanged.
- [x] No error silenced with `@ts-nocheck`, `as any`, or an exclusion.

## Files touched

- `apps/ingest/tsconfig.json`, `apps/web/tsconfig.json`,
  `apps/github-app/tsconfig.json`, `packages/auth/tsconfig.json`,
  `packages/db/tsconfig.json`, `packages/github/tsconfig.json`,
  `packages/redaction/tsconfig.json`, `packages/schemas/tsconfig.json`
- `packages/redaction/package.json` (adds `@types/node`; its test reaches for
  `node:fs`, `node:path`, `import.meta.dirname` and `performance`)
- `apps/ingest/test/helpers.ts` (new `makeTestConfig()`), plus 17 `apps/ingest`,
  4 `apps/web`, 3 `apps/github-app` and 1 `packages/auth` test files
- **No production source file changed.**

## Out of scope

- **`apps/hook`** — 32 tests, all co-located under `src/`, already fully
  checked. Untouched.
- **Normalizing where tests live.** The repo is inconsistent: `apps/hook` and
  most of `packages/schemas` co-locate under `src/`; everything else uses
  `test/`. Both are now inside the gate, so the inconsistency is cosmetic rather
  than load-bearing. Worth doing eventually — a single convention would have
  made this bug impossible — but it is a large mechanical move and belongs in
  its own task.

## Residual gaps (deliberately left)

- **`bench/` directories are still outside the gate**: `apps/hook/bench/` and
  `packages/redaction/bench/`. Same class of hole, two files, no assertions.
- **`infra/migrations-runner/run.ts` has no `tsconfig.json` at all** and is not
  a workspace, so `turbo run typecheck` never sees it. It is the one-shot
  container that applies every SQL migration at stack boot. Nothing typechecks
  it today.
- **`{} as unknown as Config`** appears in `apps/ingest/test/price-table.test.ts`
  and `test/transcripts.integration.test.ts`. Those typecheck, but they are the
  same bypass in a different costume; `makeTestConfig()` now exists for them.
- **Pre-existing `as any` in `apps/web/test/sync-login-teams.test.ts`** (the db
  mock). Left alone — not introduced here, and removing it is unrelated work.

## Verification

```bash
bun install

# gates
bun run check
bun run typecheck
bun run build
bun run test

# the probe must now FAIL (it exited 0 before this task)
printf '\nconst __gap_probe: number = "nope";\nexport { __gap_probe };\n' \
  >> apps/ingest/test/alert-email.test.ts
bun run --cwd apps/ingest typecheck   # expect: exit 1
git checkout -- apps/ingest/test/alert-email.test.ts
git status --porcelain                # expect: clean
```
