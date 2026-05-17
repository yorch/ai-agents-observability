---
id: P1-013
title: GET /v1/price-table
phase: 1
workstream: B
status: blocked
owner: null
depends_on: [P1-008]
blocks: [P1-021]
estimate: XS
---

## Goal

`GET /v1/price-table` returns the current versioned model price table. Hook uses this to compute event costs locally; ingest uses it server-side to verify those costs.

## Context

- `DESIGN_DOC.md` §7.2 covers cost calculation.
- v1: prices live in a JSON file checked into the repo (`apps/ingest/src/data/price-table.v1.json`). No DB row, no admin UI.
- Version bumps when prices change; clients refetch on startup and when ingest returns `X-Price-Table-Mismatch`.

## Acceptance criteria

- [ ] `apps/ingest/src/data/price-table.v1.json` exists with current Claude model prices (input/output/cache_read/cache_write per Mtok). Source URL noted in a comment.
- [ ] `GET /v1/price-table` returns the JSON validated against `PriceTable` schema from `@pkg/schemas`. ETag set to the version.
- [ ] No auth required (it's public-by-nature).
- [ ] If client sends `If-None-Match` matching current version, returns 304.
- [ ] Response cached `Cache-Control: public, max-age=3600`.
- [ ] Test: GET returns 200 + valid body; ETag round-trip yields 304.

## Implementation notes

- Don't fetch from Anthropic at request time — bundle the JSON in the image.
- Add a `versioned-as` comment in the JSON file: `{ "_comment": "Update DESIGN_DOC.md §7.2 if you change this." }`.

## Files touched

- `apps/ingest/src/routes/price-table.ts`
- `apps/ingest/src/data/price-table.v1.json`
- `apps/ingest/test/price-table.test.ts`

## Out of scope

- Admin UI to edit prices (Phase 4 if at all).
- Per-org pricing overrides.

## Verification

```bash
bun --filter '@app/ingest' test
curl -i http://localhost:4000/v1/price-table | jq .version
curl -i -H 'If-None-Match: "v1"' http://localhost:4000/v1/price-table   # 304
```
