---
id: P14-013
title: Close the two remaining typecheck bypasses
phase: 14
workstream: A
status: done
owner: claude
depends_on: [P14-012]
blocks: []
estimate: S
---

## Goal

Close the two gaps P14-012 identified but left behind: a file `tsc` never
looked at, and a cast that let three test files assert against a `Config`
the service never runs with.

## Part 1 — `infra/migrations-runner/run.ts` had no `tsconfig.json`

`infra/` is not a bun workspace (root `workspaces.packages` is
`["apps/*", "packages/*"]`), so `turbo run typecheck` could not reach
`run.ts` — the one-shot container every service gates on at boot
(`condition: service_completed_successfully`) was typechecked by nothing.

**Chosen approach:** add `infra/migrations-runner/tsconfig.json` (extends
the shared `tsconfig.base.json`, `include: ["run.ts"]` only) plus a root
`typecheck:infra` script (`tsc --noEmit -p infra/migrations-runner/tsconfig.json`)
chained onto the root `typecheck` script after `turbo run typecheck`.

**Alternatives considered and rejected:**

- **Make `infra/*` a bun workspace.** Most conventional, but the largest
  blast radius: a new `package.json`, an entry in the root `workspaces.packages`
  glob, a `turbo.json` task wire-up, and a matching `COPY <pkg>/package.json`
  line in each of the four Dockerfiles that name workspace manifests
  explicitly (`infra/migrations-runner/Dockerfile`, `apps/ingest/Dockerfile`,
  `apps/github-app/Dockerfile`, `apps/web/Dockerfile`). None of that is
  exercisable in this environment (no Docker), so a change that touches four
  Dockerfiles would ship unverified. Rejected on blast radius, not on merit.
- **Extend an existing workspace's `tsconfig` to include `run.ts`.** Crosses
  a package boundary for a file that belongs to no workspace; would also
  make that workspace's `dist/**` build output include a file it doesn't
  own. Rejected.

Module resolution for `@ai-agents-observability/db` from `run.ts` needs no
extra `paths` mapping: `packages/db` is already hoisted into the **root**
`node_modules` by the existing `apps/*` / `packages/*` workspaces (verified —
`node_modules/@ai-agents-observability/db` is a symlink to `packages/db`),
and `infra/migrations-runner` has no `node_modules` of its own to shadow it,
so TypeScript's `bundler` resolution walks up and finds it.

**No Dockerfile, `turbo.json`, or `workspaces` glob was touched.**

### Probe

Appended a deliberate type error to `run.ts`, ran `bun run typecheck` from
the repo root:

```
infra/migrations-runner/run.ts(70,7): error TS2322: Type 'string' is not
assignable to type 'number'.
error: script "typecheck:infra" exited with code 1
error: script "typecheck" exited with code 1
```

Exit code 1, confirmed via a separate non-piped invocation. `git checkout --`
restored the probed file; `grep -rn __gap_probe` returns nothing.

## Part 2 — `{} as unknown as Config` in three ingest test files

The earlier report said "two ingest tests"; the real count is **16 call
sites across 3 files**:

| file | call sites |
|---|---|
| `apps/ingest/test/price-table.test.ts` | 2 |
| `apps/ingest/test/events.integration.test.ts` | 6 |
| `apps/ingest/test/transcripts.integration.test.ts` | 8 |

Each built `createApp({} as unknown as Config, deps)` — the same
empty-config bypass P14-012 removed from `health.test.ts` and
`auth.test.ts`, wearing a cast instead of an excluded directory. Every
`Config` field `createApp` or its routers read was `undefined` in all 16
call sites.

**Fix:** replace the cast with `makeTestConfig()` (added by P14-012 in
`apps/ingest/test/helpers.ts` for exactly this), dropping the now-unused
`import type { Config }` in each file.

### What the empty configs were hiding — re-probed, not assumed

All three files exercise `createApp`, which threads `config.jira_project_keys`
into `eventsRouter` (the only config field these particular routes read —
`config.admin_secret` gates `/admin`, which none of these three files call,
and `config.git_sha` is read only by `/health`). `makeTestConfig()` sets
`jira_project_keys: []`, the same effective value the empty-object cast
produced via Zod's default. Re-ran the full set after the swap:

- All 19 tests in the three edited files pass unchanged (`price-table.test.ts`
  2/2, `events.integration.test.ts` 6/6, `transcripts.integration.test.ts`
  11/11 — the count differs from the call-site table because
  `transcripts.integration.test.ts` also has `describe('processTranscript', …)`
  cases that don't call `createApp`).
- Full `apps/ingest` suite: 269 passed, 12 skipped (unchanged skip set —
  the two `.db.test.ts` files gated on a live database), 0 failed.

**No test's result changed.** Nothing in these three files exercises a
config-dependent branch beyond the Jira allowlist default, so this is a
finding of "the bypass happened to be harmless here," not "the bypass was
safe by design" — the next test added to these files that reads e.g.
`config.admin_secret` or `config.transcript_retention_days` will now get the
service's real values instead of `undefined`.

### Probe — P14-012's guarantee still holds

Appended a deliberate type error to `apps/ingest/test/price-table.test.ts`,
ran `bun run typecheck` from the repo root: exit 1,
`test/price-table.test.ts(31,7): error TS2322: Type 'string' is not
assignable to type 'number'.` `git checkout --` restored it; `grep -rn
__gap_probe` returns nothing; `git status` clean.

## Verification

Four gates (`check` → `typecheck` → `build` → `test`) green before each of
the two commits.

## Files touched

- `infra/migrations-runner/tsconfig.json` (new)
- `package.json` (root `typecheck` script now also runs `typecheck:infra`)
- `apps/ingest/test/price-table.test.ts`,
  `apps/ingest/test/events.integration.test.ts`,
  `apps/ingest/test/transcripts.integration.test.ts`

## Shipped unverified

- The Docker build for `infra/migrations-runner` (and the other three
  images) was not exercised — no Docker in this environment, and no
  Dockerfile was touched, so this is a statement of pre-existing risk, not a
  regression: the runner's Dockerfile already only `COPY`s `run.ts` and
  `packages/db`, unchanged by this task.
