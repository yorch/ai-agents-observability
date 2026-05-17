---
id: PX-NNN
title: <short title>
phase: <1|2|3|4|5>
workstream: <A|B|C|D|E|F>
status: ready
owner: null
depends_on: []
blocks: []
estimate: <XS|S|M|L|XL>
---

## Goal

One or two sentences. What does "done" mean?

## Context

Links into `DESIGN_DOC.md` (§ references) or `PLAN.md`. Prior decisions, gotchas, anything an agent needs to avoid re-deriving.

## Acceptance criteria

- [ ] Each item is objectively verifiable.
- [ ] Prefer behavioral checks ("running X produces Y") over implementation checks ("file Z exists").
- [ ] Cover the unhappy path where relevant.

## Implementation notes

Non-binding. Libraries, API shapes, snippets. Skip if the task is obvious from the criteria.

## Files touched

Expected paths. Update as work progresses.

- `apps/foo/src/...`
- `packages/bar/...`

## Out of scope

Explicit non-goals. If you find yourself doing one of these, stop.

- ...

## Verification

Exact commands. An agent should be able to copy-paste these.

```bash
bun install
bun --filter '@app/foo' test
```
