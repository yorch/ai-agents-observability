---
id: P5-001
title: Friction score (compute + surface)
phase: 5
workstream: A
status: done
owner: claude
depends_on: [P1-011]
blocks: [P5-002]
estimate: M
---

## Goal

Compute a composite friction score [0,1] from session aggregate fields. Store in `sessions.friction_score` via nightly job. Surface in session list table and detail page.

## Acceptance criteria

- [x] `frictionScore DOUBLE PRECISION` column added to Session model (Prisma migration)
- [x] `computeFrictionScore()` in `apps/web/src/lib/effectiveness.ts` (version-pinned weights)
- [x] `compute-effectiveness` nightly job updates both `friction_score` and `shape_label` for recently-updated sessions
- [x] Session list table shows friction badge (Low/Medium/High) with on-the-fly fallback when DB value is null
- [x] `SessionRow` and `SessionDetail` types include `frictionScore`

## Friction formula (v1, FRICTION_VERSION=1)

```
denyRate      = min(permissionDenyCount / toolCallCount, 1)   [weight 0.30]
errorRate     = min(toolErrorCount / toolCallCount, 1)        [weight 0.30]
interruptRate = min(interruptCount / userMessageCount, 1)     [weight 0.25]
shortAbandoned = (status=abandoned AND duration<60s) ? 1 : 0  [weight 0.15]
score = min(1, denyRate*0.30 + errorRate*0.30 + interruptRate*0.25 + shortAbandoned*0.15)
```

Returns null if toolCallCount < 2 AND userMessageCount < 2 (insufficient data).

## Files touched

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20260606000000_phase4_phase5/migration.sql`
- `apps/web/src/lib/effectiveness.ts` (new)
- `apps/ingest/src/jobs/compute-effectiveness.ts` (new)
- `apps/ingest/src/jobs/scheduler.ts`
- `apps/web/src/lib/sessions-queries.ts`
- `apps/web/src/components/me/SessionsTable.tsx`
