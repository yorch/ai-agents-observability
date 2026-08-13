---
id: P12-001
title: Agent registry widening (PI, OMP, GEMINI_CLI) + registry-driven admin surface
phase: 12
workstream: B
status: done
owner: claude
depends_on: [P5-006, P8-002]
blocks: [P12-005, P12-007, P12-008]
estimate: S
---

## Goal

Three new agent types (`PI`, `OMP`, `GEMINI_CLI`) exist end-to-end — wire schema, DB
enum, display labels, price tables — and `/admin/adapters` enumerates agents from a
single registry rather than a hard-coded list that drifts every time an adapter lands.

## Context

`AgentTypeSchema` (`packages/schemas/src/event.ts:5`) and the Prisma `AgentType` enum
(`packages/db/prisma/schema.prisma:20`) were widened once, in P5-006, to the seven
agents anticipated then. Pi and OMP did not exist yet, and Gemini CLI had no hooks.

Adding an agent currently means editing at least five places, and `/admin/adapters`
has its own copy: `const ADAPTER_AGENTS = ['CLAUDE_CODE', 'CODEX', 'OPENCODE']`
(`apps/web/src/app/admin/adapters/page.tsx:8`). That list is *adapters we ship*, which
is a real distinction from *agent types we accept* — but it should be derived, not
retyped.

**Enum change = DB reset, not a patch migration.** Per
[`packages/db/AGENTS.md`](../packages/db/AGENTS.md), the relational layer is a single
squashed init migration and Prisma's idempotency check is name-based: editing
`migration.sql` after it has been applied is silently ignored and the local DB drifts.
The project is pre-deployment, so the documented path is edit-then-reset.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §2.4, §2.5, §2.2.

## Acceptance criteria

- [x] `AgentTypeSchema` accepts `PI`, `OMP`, `GEMINI_CLI`; an event carrying any of
      them validates.
- [x] The Prisma `AgentType` enum carries the same three values.
- [x] A fresh `db:deploy` against an empty database produces the widened enum, and
      `PI` / `OMP` / `GEMINI_CLI` sessions insert. Verified against a real
      Postgres-Timescale container: `SELECT enumlabel FROM pg_enum` returns all ten
      values in migration order, the round-trip suite passes with `DATABASE_URL`
      set (18/18), and one session row per new agent type inserts and reads back.
      `packages/db/test/agent-type-parity.test.ts` guards the same invariant
      statically, so CI catches a half-landed widening without a database.
- [x] `agentDisplayName()` returns `Pi`, `omp`, `Gemini CLI` (lowercase `omp` matches
      the project's own styling, as `opencode` already does).
- [x] An empty, registered price table exists for each new agent
      (`price-table.pi.v1.json`, `price-table.omp.v1.json`,
      `price-table.gemini_cli.v1.json`) so their models bill `$0` *via the table*
      rather than the unknown-agent fallback — the P8-002 convention.
- [x] `/admin/adapters` renders its rows from one exported registry; adding an agent
      to that registry is the only edit needed for it to appear.
- [x] `/admin/price-tables` lists the new tables without further changes.
- [x] A test asserts the wire enum, the Prisma enum, and the display-name map hold the
      same set of agent types — so the next widening cannot half-land.

## Implementation notes

Put the registry in `packages/schemas/src/agent-display.ts` (it already owns the
canonical label map) or a sibling `agent-registry.ts`, exporting both the full agent
list and the subset with shipped adapters. `/admin/adapters` imports the latter.

The cross-source consistency test is the valuable half of this task: Prisma enum
values are readable from the generated client, so the assertion can be real rather
than a restated literal.

## Files touched

- `packages/schemas/src/event.ts`, `agent-display.ts` (+ new registry, + tests)
- `packages/db/prisma/schema.prisma`, `prisma/migrations/20260625075457_init/migration.sql`
- `apps/ingest/src/data/price-table.{pi,omp,gemini_cli}.v1.json`, `src/lib/price-tables.ts`
- `apps/web/src/app/admin/adapters/page.tsx`

## Out of scope

- Real price data for the new agents — empty tables are correct here (P8-002).
- Any adapter implementation.
- Renaming the legacy `client.claude_code_version` wire field.

## Verification

```bash
bun run --cwd packages/schemas test
bun run --cwd apps/ingest test
bun run docker:infra:down:v && bun run docker:infra:up && bun run db:deploy
bun run check && bun run typecheck && bun run build && bun run test
```
