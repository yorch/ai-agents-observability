---
id: P10-002
title: Shared, configurable model policy
phase: 10
workstream: A
status: done
owner: claude
depends_on: [P8-002]
blocks: [P10-003, P10-005]
estimate: M
---

## Goal

One per-agent source of truth for model **tiers**, the **allowed-model** set, and
**cheap-work categories**, editable by an org admin without a redeploy, read by both
the optimization dashboards (P10-003/004) and the governance engine (P10-005).

## Context

See [`P10-roadmap.md`](./P10-roadmap.md). Today these definitions are duplicated and
hardcoded in `apps/web/src/app/org/models/page.tsx` (`PREMIUM_PATTERNS`, `CHEAP_CATEGORIES`,
`modelTier()`). Governance (`unknown_model_surge`, `P9-001`) has its own notion of
"known" models. Phase 10 needs one definition so a dashboard recommendation and a
governance alert can't disagree about what "premium" or "allowed" means.

Follows the project's config precedent: per-agent, price-table-adjacent, seedable.
Tiers should default to being **derived from the price table** (rank by blended
input+output rate) so a new agent's models get a sensible tier without manual entry,
with the admin override on top.

## Acceptance criteria

- [ ] A `model_policy` table (Prisma model) keyed by `agent_type` storing: tier
      overrides (`economy` / `standard` / `premium`), the allowed-model set (or
      "allow all"), and the cheap-work `tool_category` list.
- [ ] Default rows seeded via a numbered SQL seed (per the migrations convention),
      derived from the shipped price tables — no agent starts with an empty policy.
- [ ] A resolver (`resolveModelTier(agentType, model)`, `isModelAllowed(...)`,
      `cheapCategories(agentType)`) that reads the policy, falling back to price-table
      derivation when no override exists. Unit-tested.
- [ ] `/admin/model-policy` (org-admin only) lists per-agent policy and lets an admin
      edit tiers, the allowed set, and cheap categories; changes persist and take
      effect without a redeploy.
- [ ] `apps/web/src/app/org/models/page.tsx` and `P10-001`'s tier resolver both read
      this policy — the hardcoded `PREMIUM_PATTERNS` / `CHEAP_CATEGORIES` constants are
      removed.

## Implementation notes

- Prisma model + a `packages/db/sql/migrations/000N_seed_model_policy.sql` seed
  (data seeds are the allowed use of the custom-SQL layer per `AGENTS.md`).
- Resolver in `apps/web/src/lib/model-policy.ts`; keep it pure over an injected policy
  snapshot so it's testable and reusable by the ingest alert engine if needed.
- Admin UI mirrors `/admin/price-tables` / `/admin/retention` patterns (server
  actions, `requireOrgAdmin()`).

## Files touched

- `packages/db/prisma/schema.prisma`
- `packages/db/sql/migrations/000N_seed_model_policy.sql` (new)
- `apps/web/src/lib/model-policy.ts` (+ test)
- `apps/web/src/app/admin/model-policy/page.tsx` (+ actions)
- `apps/web/src/app/org/models/page.tsx` (consume policy; drop hardcoded constants)

## Out of scope

- Enforcement/alerting on the allowed set — that is P10-005.
- Recommendation math — that is P10-001.

## Verification

```bash
bun install
bun run docker:infra:down:v && bun run docker:infra:up && bun run db:deploy
bun --filter '@ai-agents-observability/web' test model-policy
bun run --cwd apps/web typecheck
```

## Audit 2026-08-18 — confirmed not built, status held at `ready`

`INDEX.md` carried this as `done`. It is not started, and the check is unambiguous:
`model_policy` appears nowhere in `schema.prisma`, in `packages/db/sql/migrations/`,
or in either app; `apps/web/src/lib/model-policy.ts` does not exist; and
`apps/web/src/app/admin/` has no `model-policy` route (its entries are
`access-grants`, `adapters`, `alerts`, `jobs`, `org-roles`, `price-tables`,
`retention`, `team-roles`).

This is the load-bearing gap in Phase 10, not a leaf. `P10-003`'s "the constants are
gone" criterion cannot be satisfied until something supplies the policy that replaces
`PREMIUM_PATTERN`, `CHEAP_SUITABLE_CATEGORIES` and `HAIKU_SAVINGS_RATIO`, and
`P10-005` depends on it outright. Reopening it keeps that chain honest.

## Built 2026-08-20 — the audit above is resolved

Every absence the audit listed now exists:

- `model_policy` is a Prisma model (`ModelPolicy`, keyed by `agent_type`) with its
  DDL in the init migration, holding tier overrides, the allowed-model set and the
  cheap-category list.
- `apps/web/src/lib/model-policy.ts` and `apps/ingest/src/lib/model-policy.ts` are
  thin per-app adapters over one shared resolver in `packages/schemas`; only the
  price source differs (HTTP vs in-process tables).
- `/admin/model-policy` exists, org-admin gated, audit-logged under a new
  `AuditAction.MODEL_POLICY_CHANGED`, effective without a redeploy.

The chain the audit called out is unblocked with it: `P10-003`'s "the constants are
gone" criterion is met, and `P10-005` is built on this policy.

## Deliberate deviation: no seeded rows

The criteria asked for default rows **seeded** from the shipped price tables. Tiers
are derived **on read** instead, with only the admin's overrides stored.

A seeded row snapshots tiers at seed time. `P12-012` regenerated three tables from
the models.dev catalog in a single PR — 34 models each to ~243 — and every seeded
tier would have gone stale that day, with no way to tell a deliberate choice from an
unrevisited default. Deriving on read re-tiers automatically while overrides survive.

The criterion's intent — *"no agent starts with an empty policy"* — holds: every
agent resolves to a complete policy immediately. What it lacks is a **row** until an
admin saves one.
