# Task System

The contract for how AI agents (and humans) pick up, execute, and track work on this project.

## Layout

```
tasks/
├── README.md          # This file — the rules
├── INDEX.md           # Status table. Single source of truth for state.
├── _template.md       # Copy this when adding a new task.
├── P1-XXX-*.md        # Phase 1 tasks (fully decomposed)
├── P2-roadmap.md      # Phase 2 sketch — decompose when Phase 1 exits
├── P3-roadmap.md
├── P4-roadmap.md
└── P5-roadmap.md
```

## Task file format

Every task file starts with YAML frontmatter, followed by Markdown body.

```yaml
---
id: P1-007              # Phase number + 3-digit ordinal. Stable forever.
title: Ingest API skeleton
phase: 1
workstream: B           # See PLAN.md §3 for workstream letters
status: ready           # See "Status values" below
owner: null             # null until claimed; agent ID or human handle once claimed
depends_on: [P1-001]    # IDs of tasks that must be `done` before this can start
blocks: [P1-008, P1-009]  # Optional: tasks that wait on this. For navigation.
estimate: M             # T-shirt size: XS, S, M, L, XL (XS≈hours, XL≈week+)
---
```

Body sections (use H2 headings, in this order):

1. **Goal** — one or two sentences. What does "done" mean?
2. **Context** — links into `DESIGN_DOC.md` or `PLAN.md`, prior decisions, gotchas.
3. **Acceptance criteria** — bulleted checklist. Each item must be objectively verifiable.
4. **Implementation notes** — non-binding guidance. APIs, libraries, examples.
5. **Files touched** — expected paths (best-effort; updated as work progresses).
6. **Out of scope** — explicit non-goals to prevent scope creep.
7. **Verification** — exact commands to run that prove the acceptance criteria pass.

## Status values

| Status | Meaning |
|---|---|
| `ready` | Dependencies all `done`. Anyone can claim it. |
| `blocked` | Has unmet dependencies, or hit an external blocker (described in the file). |
| `in-progress` | Someone is actively working on it. `owner` is set. |
| `review` | Work is done; awaiting code review or sign-off. |
| `done` | Merged or otherwise complete. Acceptance criteria all checked. |
| `cancelled` | Decided not to do this. File kept for history. |

## Workflow

**Claiming a task:**
1. Open `INDEX.md`. Find the task you want; confirm `status: ready`.
2. Open the task file. Confirm dependencies are all `done` by spot-checking.
3. Edit the task file: set `status: in-progress` and `owner: <your-id>`.
4. Edit `INDEX.md`: update the same two fields in the table.
5. Commit: `chore(tasks): claim P1-XXX`.

**Finishing a task:**
1. Verify all acceptance criteria are met (run the commands in Verification).
2. Edit the task file: set `status: review` (or `done` if no review required), check off all acceptance-criteria items.
3. Edit `INDEX.md`: update status.
4. Commit alongside the implementation, or in a follow-up: `chore(tasks): complete P1-XXX`.

**Hitting a blocker:**
1. Edit the task file: set `status: blocked`. Add a `## Blocker` section explaining what's wrong.
2. Edit `INDEX.md`: update status.
3. Commit: `chore(tasks): block P1-XXX on <reason>`.
4. Move to a different task.

**Adding a new task:**
1. Copy `_template.md`. Name it `P<phase>-<next-ordinal>-<slug>.md`.
2. Fill in frontmatter and body.
3. Add a row to `INDEX.md` in the correct phase section.
4. If it has dependents, update their `depends_on`.

## Rules for agents

- **Never start a task whose dependencies aren't `done`.** Even if it looks like it could go in parallel, the dependency declaration is the contract.
- **Never silently change another agent's task.** If you must touch one that's `in-progress`, leave a comment in the body explaining why.
- **Update `INDEX.md` in the same commit as the task file.** They drift fast otherwise.
- **Keep acceptance criteria objective.** "Looks good" is not a criterion; "passes `bun --filter '@app/ingest' test`" is.
- **Run Biome before marking review.** `bun run check` (lint + format check) must pass. `bun run format --write` if needed.
- **Out-of-scope is sacred.** If you find yourself doing something listed under "Out of scope", stop and either expand the task (with a note) or split off a new one.
- **Don't gold-plate.** If a task is `M`, don't turn it into `L` by adding nice-to-haves. File a follow-up task instead.

## Tracking progress externally

`INDEX.md` is the canonical view. If/when this grows past ~50 active tasks we'll generate it from frontmatter. For now it's hand-maintained — keep it accurate.
