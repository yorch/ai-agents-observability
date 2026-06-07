---
id: P5-002
title: Session-shape clustering
phase: 5
workstream: A
status: done
owner: claude
depends_on: [P5-001]
blocks: []
estimate: M
---

## Goal

Classify sessions into shape labels based on tool histogram: exploratory, focused-edit, debugging, planning, multi-tool, minimal. Stored in `sessions.shape_label` and surfaced in the session list.

## Acceptance criteria

- [x] `shapeLabel TEXT` column added to Session model (same migration as friction_score)
- [x] `classifySessionShape()` in `apps/web/src/lib/effectiveness.ts`
- [x] `compute-effectiveness` job queries events per session for tool histogram, computes shape label
- [x] Shape badge shown in SessionsTable with color coding
- [x] `SessionRow` and `SessionDetail` types include `shapeLabel`

## Shape classification rules (v1)

| Label | Rule |
|---|---|
| `minimal` | < 3 tool calls AND < 3 user messages |
| `exploratory` | readFrac > 0.6 AND writeFrac < 0.15 |
| `focused-edit` | writeFrac > 0.5 |
| `debugging` | execFrac > 0.4 AND writeFrac < 0.2 |
| `planning` | userMessages > 70% of (toolCalls + userMessages) |
| `multi-tool` | no dominant category (maxFrac < 0.35) |

Read tools: Read, Glob, Grep, LS, WebFetch, WebSearch  
Write tools: Edit, Write, MultiEdit  
Exec tools: Bash, Exec, Shell

## Files touched

- `packages/db/prisma/schema.prisma` (shapeLabel field)
- `apps/web/src/lib/effectiveness.ts` (classifySessionShape, shapeBadge)
- `apps/ingest/src/jobs/compute-effectiveness.ts`
- `apps/web/src/lib/sessions-queries.ts`
- `apps/web/src/components/me/SessionsTable.tsx`
