---
id: P10-002
title: Shared, configurable model policy
phase: 10
workstream: A
status: ready
owner: null
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
