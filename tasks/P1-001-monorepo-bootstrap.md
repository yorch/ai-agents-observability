---
id: P1-001
title: Monorepo bootstrap (Turborepo + pnpm)
phase: 1
workstream: A
status: ready
owner: null
depends_on: []
blocks: [P1-002, P1-003, P1-006, P1-007, P1-008, P1-014, P1-015, P1-019, P1-024]
estimate: M
---

## Goal

Stand up the Turborepo + pnpm workspace with shared TypeScript / lint / format tooling. After this task, every other task can assume the layout in `PLAN.md` §2 exists and `pnpm install` works from a clean clone.

## Context

- `PLAN.md` §2 defines the directory layout.
- `PLAN.md` §4 defines cross-cutting standards (ESLint, Prettier, pino, Conventional Commits).
- Node 20 LTS + pnpm 9 + Bun 1.1 are the assumed toolchain. Pin versions in `package.json` `packageManager` and `.nvmrc`.

## Acceptance criteria

- [ ] Root `package.json` declares `pnpm@9.x` as `packageManager` and `"private": true`.
- [ ] `pnpm-workspace.yaml` lists `apps/*` and `packages/*`.
- [ ] `turbo.json` defines pipelines: `build`, `lint`, `test`, `typecheck`, `dev`. `dev` is non-cacheable.
- [ ] Shared `tsconfig.base.json` at root; each package extends it.
- [ ] ESLint + Prettier configured at root. `pnpm lint` passes on the empty tree.
- [ ] `.editorconfig`, `.nvmrc` (node 20), `.gitignore` (with `dist`, `.env*` except `.env.example`, `node_modules`, `.turbo`).
- [ ] Empty stub packages exist for the layout: `apps/{ingest,web,hook}`, `packages/{db,schemas,redaction,github,auth}`. Each has its own `package.json` and `tsconfig.json` extending the base.
- [ ] `pnpm install && pnpm typecheck` succeeds from a clean clone with no source files.
- [ ] `.env.example` at repo root enumerating every env var the project will use (initially empty; later tasks append).
- [ ] CI workflow stub at `.github/workflows/ci.yml` runs `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Implementation notes

- Use `pnpm dlx create-turbo@latest` as a starting point but strip the default Next.js app — we'll add ours in P1-024.
- For the `apps/hook` stub, set `"type": "module"` and add a `bun` field to `package.json` for the Bun-specific config.
- `packages/db` will be tricky because Prisma's generated client lives in `node_modules`. Use `prisma generate --schema=...` in the package's `build` script; don't commit generated output.

## Files touched

- `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `.editorconfig`, `.nvmrc`, `.gitignore`
- `apps/{ingest,web,hook}/package.json` (+ `tsconfig.json`, `src/index.ts` empty stub)
- `packages/{db,schemas,redaction,github,auth}/package.json` (+ `tsconfig.json`, `src/index.ts` empty stub)
- `.github/workflows/ci.yml`
- `.env.example`

## Out of scope

- Actual app/package code — just empty stubs.
- Docker (P1-002).
- Prisma schema (P1-003).
- Release workflow.

## Verification

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test  # passes trivially (no tests yet)
```
