---
id: P1-001
title: Monorepo bootstrap (Bun + Turborepo 3 + Biome)
phase: 1
workstream: A
status: done
owner: null
depends_on: []
blocks: [P1-002, P1-003, P1-006, P1-007, P1-008, P1-014, P1-015, P1-019, P1-024]
estimate: M
---

## Goal

Stand up the Bun-native monorepo: Bun 1.3 workspaces, Turborepo 3, Biome 2 (lint + format), shared TypeScript config, and version-pinned tooling via Bun catalogs. After this task, every other task can assume the layout in `PLAN.md` §2 exists and `bun install && bun run check && bun run typecheck` works from a clean clone.

## Context

- `PLAN.md` §1 (decisions table) and §1 (pinned tool versions) — every floor version is declared there.
- `PLAN.md` §2 defines the directory layout.
- `PLAN.md` §4 commits to Bun as package manager + runner, Biome 2, pino, Conventional Commits, Vitest 4.
- **Use hoisted installs, not isolated** — Bun 1.3 has known bugs with isolated + catalogs ([oven-sh/bun#23615](https://github.com/oven-sh/bun/issues/23615)). Set `[install] linker = "hoisted"` in `bunfig.toml`. Revisit when the bug is fixed.
- **Turborepo 3** is required for first-class Bun workspace detection; Turbo 2 will miss the `bun.lock`.
- Tailwind 4 has no `tailwind.config.js` — that comes in P1-024. This task just makes sure the workspace is ready.

## Acceptance criteria

- [ ] Root `package.json` declares:
  - `"private": true`
  - `"engines": { "node": ">=24", "bun": ">=1.3.13" }`
  - `"workspaces": ["apps/*", "packages/*"]`
  - `"workspaces.catalog": { ... }` block centralizing the versions in `PLAN.md` §1 (turbo, typescript, biome, vitest, hono, zod, jose, octokit, prisma, react, next, tailwindcss, @aws-sdk/client-s3, pino, croner — every shared dep).
- [ ] `.nvmrc` pins Node 24 LTS (for the Next.js runtime; Bun isn't bound by it).
- [ ] `bunfig.toml` at root sets:
  ```toml
  [install]
  linker = "hoisted"           # required: see PLAN.md §6 (oven-sh/bun#23615)
  exact = true                 # required: PLAN.md §4 pinning policy — bun add writes exact versions
  saveTextLockfile = true      # text bun.lock, not legacy bun.lockb
  registry = "https://registry.npmjs.org/"
  # CI overrides with: bun install --frozen-lockfile
  ```
- [ ] `engines` in root `package.json` pins exact runtimes:
  ```json
  "engines": { "node": "24.6.0", "bun": "1.3.13" }
  ```
- [ ] `.github/workflows/ci.yml` uses `oven-sh/setup-bun@v2` with `bun-version: 1.3.13` and `actions/setup-node@v4` with `node-version: 24.6.0` — both exact, no `lts/*`.
- [ ] Sub-package `package.json` files use `"catalog:"` for shared deps (e.g. `"zod": "catalog:"`).
- [ ] `bun.lock` committed (text format, v3).
- [ ] `turbo.json` (Turborepo 3) defines pipelines: `build`, `check` (= `biome check`), `format`, `test`, `typecheck`, `dev`. `dev` is non-cacheable. Turbo auto-detects Bun.
- [ ] Shared `tsconfig.base.json` at root targeting `ES2024`, `module: "preserve"`, `moduleResolution: "bundler"`, `strict: true`, `noUncheckedIndexedAccess: true`. Each package extends it.
- [ ] `biome.json` at root configured for:
  - lint + format enabled
  - line width 100, single quotes, trailing commas (`"all"`), semicolons required
  - `organizeImports` enabled
  - recommended rules + `correctness/noUnusedImports: error`, `style/useImportType: error`
  - `vcs.useIgnoreFile: true` so Biome respects `.gitignore`
- [ ] Root `package.json` `scripts`:
  - `"check": "biome check --error-on-warnings"`
  - `"format": "biome format --write"`
  - `"typecheck": "turbo run typecheck"`
  - `"test": "turbo run test"`
  - `"build": "turbo run build"`
  - `"dev:stack": "docker compose -f infra/docker-compose.yml up -d"` (placeholder until P1-002)
- [ ] `.editorconfig`, `.gitignore` (includes `dist`, `.env*` except `.env.example`, `node_modules`, `.turbo`, `*.tsbuildinfo`).
- [ ] Empty stub packages exist for the layout: `apps/{ingest,web,hook}`, `packages/{db,schemas,redaction,github,auth}`. Each has its own `package.json` (with `"engines": { "node": ">=24" }`) and `tsconfig.json` extending the base.
- [ ] `apps/{ingest,hook}` `package.json` declares Bun as runtime in `engines` — they run via `bun`, not node.
- [ ] `apps/web` `package.json` declares Node 24 as runtime — Next.js 16 prod runs on Node, not Bun.
- [ ] `bun install --frozen-lockfile && bun run check && bun run typecheck` succeeds from a clean clone with no source files.
- [ ] `renovate.json` at repo root configures:
  - schedule weekly (Monday mornings) so PRs don't pile up
  - never auto-merge
  - group major/minor/patch by ecosystem (React + react-dom + Next.js as one group; Prisma + @prisma/client as one group; Tailwind + @tailwindcss/postcss as one group)
  - separate group for security patches (label `security`, no schedule)
  - catalog awareness: update the root catalog entry, not per-package versions
- [ ] `.env.example` at repo root enumerating every env var the project will use (initially empty; later tasks append).
- [ ] CI workflow stub at `.github/workflows/ci.yml`:
  - Uses `oven-sh/setup-bun@v2` pinned to `bun-version: 1.3.13` (exact).
  - Uses `actions/setup-node@v4` pinned to `node-version: 24.6.0` (exact) for the Next.js build.
  - GitHub Actions themselves pinned to commit SHAs (not just `@v2`/`@v4` tags) — supply-chain hardening. Document the SHAs in a comment next to each `uses:` line.
  - Runs `bun install --frozen-lockfile` (fails the build if `bun.lock` is out of sync with `package.json`), then `bun run typecheck`, `bun run check`, `bun run test`.
  - Biome is invoked via `bun run check` (catalog-installed) — no separate `biomejs/setup-biome` step needed.

## Implementation notes

- Bun catalog syntax (root `package.json`). **Exact versions only — no carets, no tildes.** Per `PLAN.md` §4 pinning policy:
  ```json
  {
    "workspaces": {
      "packages": ["apps/*", "packages/*"],
      "catalog": {
        "zod": "4.1.0",
        "hono": "4.12.19",
        "@hono/zod-validator": "0.4.4",
        "prisma": "7.7.0",
        "@prisma/client": "7.7.0",
        "next": "16.2.0",
        "react": "19.2.6",
        "react-dom": "19.2.6",
        "tailwindcss": "4.1.0",
        "@tailwindcss/postcss": "4.1.0",
        "@aws-sdk/client-s3": "3.1047.0",
        "octokit": "5.0.5",
        "@octokit/webhooks": "14.1.0",
        "jose": "6.2.3",
        "pino": "10.3.1",
        "pino-pretty": "14.0.0",
        "pino-roll": "4.0.0",
        "croner": "10.0.1",
        "vitest": "4.1.6",
        "fast-check": "4.4.0",
        "react-virtuoso": "5.0.0",
        "keytar": "8.0.0",
        "@biomejs/biome": "2.4.0",
        "typescript": "6.0.0",
        "turbo": "3.0.0"
      }
    }
  }
  ```
- Sub-package reference: `"zod": "catalog:"` — Bun resolves to the root catalog. Never write a version range in a sub-package; if you need a divergent version, add a second named catalog (`workspaces.catalogs.legacy`) and document why.
- The full canonical version table lives in `PLAN.md` §1 "Pinned tool versions" — keep this catalog and that table in lockstep when bumping.
- Don't pull in Corepack. Bun is installed directly (CI uses `setup-bun`).
- Don't try Bun's isolated installs yet — `linker = "hoisted"` is mandatory until [#23615](https://github.com/oven-sh/bun/issues/23615) is fixed.
- Biome config tip: enable `linter.rules.nursery.useSortedClasses` only after Tailwind 4 is installed in P1-024.
- `apps/web` Next.js still uses Node for `next dev` / `next build`. Wire its `dev` / `build` scripts to invoke `node node_modules/next/dist/bin/next ...` explicitly, or rely on `bunx --bun=false` to force Node. Don't run Next under Bun in this phase.

## Files touched

- `package.json` (root, with workspaces + catalog)
- `bunfig.toml`
- `bun.lock`
- `turbo.json`
- `biome.json`
- `tsconfig.base.json`, `.editorconfig`, `.nvmrc`, `.gitignore`
- `apps/{ingest,web,hook}/package.json` (+ `tsconfig.json`, `src/index.ts` empty stub)
- `packages/{db,schemas,redaction,github,auth}/package.json` (+ `tsconfig.json`, `src/index.ts` empty stub)
- `.github/workflows/ci.yml`
- `renovate.json`
- `.env.example`

## Out of scope

- Actual app/package code — just empty stubs.
- Docker (P1-002).
- Prisma schema (P1-003).
- Release workflow.
- Tailwind config (P1-024).

## Verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun run check                 # Biome lint + format check
bun run test                  # passes trivially (no tests yet)
bun run format && git diff --exit-code   # format stable
```
