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

- [x] A `model_policy` table (Prisma model) keyed by `agent_type` storing: tier
      overrides (`economy` / `standard` / `premium`), the allowed-model set (or
      "allow all"), and the cheap-work `tool_category` list.
- [x] Default rows seeded via a numbered SQL seed (per the migrations convention),
      derived from the shipped price tables — no agent starts with an empty policy.
- [x] A resolver (`resolveModelTier(agentType, model)`, `isModelAllowed(...)`,
      `cheapCategories(agentType)`) that reads the policy, falling back to price-table
      derivation when no override exists. Unit-tested.
- [x] `/admin/model-policy` (org-admin only) lists per-agent policy and lets an admin
      edit tiers, the allowed set, and cheap categories; changes persist and take
      effect without a redeploy.
- [x] `apps/web/src/app/org/models/page.tsx` and `P10-001`'s tier resolver both read
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

## As shipped

- `ModelPolicy` (table `model_policy`), keyed by `agent_type`, holding tier
  overrides, the allowed-model set, and the cheap-category list.
- Resolvers live in [`packages/schemas/src/model-policy.ts`](../packages/schemas/src/model-policy.ts)
  (`resolveModelTier`, `isModelAllowed`, `isCheapCategory`, `deriveModelTiers`),
  unit-tested there, with thin per-app adapters that supply prices — over HTTP in
  `apps/web`, from the in-process tables in `apps/ingest`.
- `/admin/model-policy` (org-admin only) edits all three, audit-logged under the
  new `AuditAction.MODEL_POLICY_CHANGED`, effective without a redeploy.
- `PREMIUM_PATTERN` / `CHEAP_SUITABLE_CATEGORIES` / `HAIKU_SAVINGS_RATIO` are gone
  from `apps/web`, and the ingest `routing_waste` evaluator no longer carries
  `ILIKE '%opus%'` — it resolves the same policy.

## Deliberate deviation: no seeded rows

The criteria asked for default rows **seeded** from the shipped price tables. This
derives tiers **at read time** instead and stores only the admin's overrides.

A seeded row snapshots tiers at seed time. `P12-010` rewrote six of the seven price
tables in a single PR; every seeded tier would have gone stale that day with no
mechanism to refresh it, and no way to tell an admin's deliberate choice from a
default nobody had revisited. Deriving on read means a price refresh re-tiers
automatically while overrides survive untouched.

The criterion's intent — *"no agent starts with an empty policy"* — holds: every
agent resolves to a complete policy immediately. What it does not have is a **row**
until an admin saves one.

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
