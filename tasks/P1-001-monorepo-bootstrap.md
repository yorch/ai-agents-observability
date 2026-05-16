---
id: P1-001
title: Monorepo bootstrap (Turborepo + pnpm + Biome)
phase: 1
workstream: A
status: ready
owner: null
depends_on: []
blocks: [P1-002, P1-003, P1-006, P1-007, P1-008, P1-014, P1-015, P1-019, P1-024]
estimate: M
---

## Goal

Stand up the Turborepo + pnpm workspace with Biome 2 (lint + format), shared TypeScript config, and version-pinned tooling via `pnpm.catalogs`. After this task, every other task can assume the layout in `PLAN.md` §2 exists and `pnpm install && pnpm check && pnpm typecheck` works from a clean clone.

## Context

- `PLAN.md` §1 (decisions table) and §1 (pinned tool versions) — every floor version is declared there.
- `PLAN.md` §2 defines the directory layout.
- `PLAN.md` §4 commits to Biome 2 (single binary, no ESLint/Prettier), pino, Conventional Commits, Vitest 4.
- pnpm 8.15 (NOT 11) — pnpm 11 catalogs + Turborepo + Corepack interplay is still rough (see `PLAN.md` §6).
- Tailwind 4 has no `tailwind.config.js` — that comes in P1-024. This task just makes sure the workspace is ready.

## Acceptance criteria

- [ ] Root `package.json` declares `"packageManager": "pnpm@8.15.x"` and `"private": true`. `engines.node: ">=24"`.
- [ ] `.nvmrc` pins Node 24 LTS.
- [ ] `pnpm-workspace.yaml` lists `apps/*` and `packages/*` and defines a `catalog:` block centralizing the versions in `PLAN.md` §1 (turbo, typescript, biome, vitest, bun, hono, zod, jose, octokit, prisma, react, next, tailwindcss, @aws-sdk/client-s3, pino, croner — every shared dep).
- [ ] Sub-package `package.json` files use `"catalog:"` for shared deps (e.g. `"zod": "catalog:"`).
- [ ] `turbo.json` defines pipelines: `build`, `check` (= `biome check`), `format`, `test`, `typecheck`, `dev`. `dev` is non-cacheable.
- [ ] Shared `tsconfig.base.json` at root targeting `ES2024`, `module: "preserve"`, `moduleResolution: "bundler"`, `strict: true`, `noUncheckedIndexedAccess: true`. Each package extends it.
- [ ] `biome.json` at root configured for:
  - lint + format enabled
  - line width 100, single quotes, trailing commas (`"all"`), semicolons required
  - `organizeImports` enabled
  - recommended rules + `correctness/noUnusedImports: error`, `style/useImportType: error`
  - `vcs.useIgnoreFile: true` so Biome respects `.gitignore`
- [ ] `pnpm check` runs `biome check --error-on-warnings` across the tree; `pnpm format` runs `biome format --write`.
- [ ] `.editorconfig`, `.gitignore` (includes `dist`, `.env*` except `.env.example`, `node_modules`, `.turbo`, `*.tsbuildinfo`).
- [ ] Empty stub packages exist for the layout: `apps/{ingest,web,hook}`, `packages/{db,schemas,redaction,github,auth}`. Each has its own `package.json` (with `engines.node: ">=24"`) and `tsconfig.json` extending the base.
- [ ] `apps/hook` `package.json` declares Bun 1.3.x as engine (in addition to node) — its build/run is Bun-only.
- [ ] `pnpm install && pnpm check && pnpm typecheck` succeeds from a clean clone with no source files.
- [ ] `.env.example` at repo root enumerating every env var the project will use (initially empty; later tasks append).
- [ ] CI workflow stub at `.github/workflows/ci.yml` (on Node 24, pnpm 8.15) runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm check` (Biome), `pnpm test`.
- [ ] `.github/workflows/ci.yml` uses `biomejs/setup-biome@v2` action for Biome caching.

## Implementation notes

- Start from `pnpm dlx create-turbo@latest --skip-install`, then strip everything Turborepo's default scaffold adds (Next.js apps, ESLint configs) — they don't match our choices.
- Don't use Corepack. Install pnpm explicitly in CI (`npm i -g pnpm@8.15`) — Corepack + Turborepo + catalogs is the combo that misbehaves.
- `pnpm.catalogs` syntax (pnpm 8.15 supports the `default` catalog; multiple named catalogs landed in pnpm 9 but we don't need them):
  ```yaml
  # pnpm-workspace.yaml
  packages:
    - 'apps/*'
    - 'packages/*'
  catalog:
    zod: ^4.0.0
    hono: ^4.12.0
    # ...
  ```
- For `apps/hook` Bun-specific config: add a `bun` field to its `package.json` and a `bunfig.toml` if needed.
- Biome config tip: enable `linter.rules.nursery.useSortedClasses` only after Tailwind 4 is installed in P1-024 (it understands `@theme`).

## Files touched

- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json`
- `tsconfig.base.json`, `.editorconfig`, `.nvmrc`, `.gitignore`
- `apps/{ingest,web,hook}/package.json` (+ `tsconfig.json`, `src/index.ts` empty stub)
- `packages/{db,schemas,redaction,github,auth}/package.json` (+ `tsconfig.json`, `src/index.ts` empty stub)
- `.github/workflows/ci.yml`
- `.env.example`

## Out of scope

- Actual app/package code — just empty stubs.
- Docker (P1-002).
- Prisma schema (P1-003).
- Release workflow.
- Tailwind config (P1-024).

## Verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check                 # Biome lint + format check
pnpm test                  # passes trivially (no tests yet)
pnpm format --write && git diff --exit-code   # format stable
```
