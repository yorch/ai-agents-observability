# Documentation Audit — Human Docs and Agent Docs

**Date:** 2026-08-02
**Scope:** Every Markdown file in the repo (132 files), assessed against current
Claude Code memory guidance and the AGENTS.md conventions that settled during
2026. Covers both audiences — docs humans read and docs agents load.
**Status:** Assessment. The **Tier 1** corrections below were applied in the same
PR. Tiers 2–4 are recommendations awaiting a decision.

---

## 0. TL;DR

The documentation is **unusually good for a project this size** — far above the
median for a 4-app monorepo. `DESIGN_DOC.md` is a genuine design document rather
than a README with headings, the task system is real and mostly honest, and
`apps/web/AGENTS.md` is the best file in the repo: dense, specific, and written
from scars rather than from a template.

The problems are not quality problems. They are **drift and duplication**
problems, and they all trace to one structural cause:

> **The same fact is asserted in four to six places, and nothing checks that the
> copies agree.**

Redaction rule count is stated in five files; two were wrong. Phase status is
stated in five files; four omitted two entire phases. `Last updated:` headers are
maintained by hand and two had gone a month stale while the body kept changing.
The fix is not "write more docs." It is **fewer assertions of the same fact, and
a cheap check that the survivors stay true.**

The second finding is an omission, and it is a slightly awkward one:

> **This repo is an observability platform for AI coding agents, and it has no
> `.claude/` directory.** No settings, no rules, no skills, no hooks, no slash
> commands. It documents Claude Code hook semantics for its users while using
> none of the extension surface itself.

---

## 1. What exists

| Layer | Files | Assessment |
|---|---|---|
| **Agent memory** | `AGENTS.md` (140 ln), `apps/web/AGENTS.md` (51 ln, dense) | Strong. Both within the 200-line target. |
| **Canonical design** | `DESIGN_DOC.md` (1,211 ln) | Excellent. Real rationale, real trade-offs, a maintained history table. |
| **Planning** | `PLAN.md` (258 ln), `OPPORTUNITIES.md` (285 ln), `docs/PROJECT_OVERVIEW.md` (343 ln) | Good individually; **heavily overlapping** as a set. See §4. |
| **Task system** | `tasks/` — 96 files, `INDEX.md`, `README.md`, `_template.md` | The best-run part of the repo. Contract is explicit and mostly followed. |
| **Ops** | `docs/slos.md`, `docs/on-call.md`, `docs/runbooks/` ×5 | Solid, appropriately scoped, no drift found. |
| **Package docs** | `apps/hook/`, `packages/github/`, `packages/redaction/` | Good where present. **5 of 12 workspaces have any README.** |
| **Spec/plan/research** | `docs/specs/`, `docs/plans/`, `docs/research/` | One spec, one plan, one research doc. A convention that started and stalled. |
| **Entry point** | `README.md` (123 ln) | Fine, but carries a hand-copied status summary that drifts. |

**Link integrity: clean.** All 132 files scanned; **zero broken relative links**.
That is genuinely rare and worth protecting with a CI check (§5, Tier 2).

---

## 2. Best-practice research

Two sources, and they agree more than they differ.

**Claude Code's own memory guidance** ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)):

- **Target under 200 lines per file.** Longer files consume context *and reduce
  adherence* — the failure mode is not truncation, it is the model weighting the
  instructions less.
- **Claude Code reads `CLAUDE.md`, not `AGENTS.md`.** The documented bridges are
  an `@AGENTS.md` import or a symlink. This repo already uses the symlink — correctly.
- **`.claude/rules/` with `paths:` frontmatter** scopes instructions to file globs
  so they load only when Claude touches matching files. This is the intended
  answer to "my instructions are getting long."
- **Cut what the model can derive.** The `/doctor` trim check explicitly removes
  directory layouts, dependency lists, and architecture overviews, and keeps
  *pitfalls, rationale, and conventions that differ from tool defaults*.
- **Contradictions are the top adherence risk.** "If two rules contradict each
  other, Claude may pick one arbitrarily."
- **HTML comments are stripped** before injection — free maintainer notes.
- Nested files load **on demand** when Claude reads files in that directory, and
  are **not re-injected after `/compact`** (project-root `CLAUDE.md` is).

**The wider AGENTS.md convention** (now read natively by Claude Code, Codex CLI,
Cursor, Aider, Devin, Copilot, Gemini CLI, Windsurf, Amazon Q):

- Nearest file to the edited file wins; **keep shared rules at the root and only
  repeat a rule lower down when you are replacing it.**
- **Lead with commands, not explanation.**
- Measured: LLM-generated AGENTS.md files *reduced* task success by ~2% and
  raised cost ~23%, "primarily because they duplicated content already available
  in the repository." **Duplication is not neutral. It is a measurable tax.**

**How this repo scores.** Size: good. Symlink bridge: correct. Specificity:
excellent — `apps/web/AGENTS.md` is a model of the genre. Duplication: **this is
where the repo loses points**, and per the finding above, that is the expensive axis.

---

## 3. Tier 1 — factual errors (applied in this PR)

Each was verified against the code, not inferred.

| # | File | Was | Verified truth |
|---|---|---|---|
| 1 | `packages/redaction/README.md` | "Seven rule classes"; 7-row table | **Nine** rules in `src/index.ts`; `git-remote-url` and `email` were missing from the table entirely, and the load-bearing ordering was undocumented |
| 2 | `README.md` | "9-class" ← was "7-class" | same |
| 3 | `PLAN.md` §3 | "seven-class test suite" | same — now notes seven at Phase 1, nine today |
| 4 | `docs/PROJECT_OVERVIEW.md` §6 | "Still **7 rules** … **No dedicated email/PII or git-remote-URL rule yet**" | **Self-contradictory** — §8 of the same file already said both rules ship. Both shipped 2026-07-13 |
| 5 | `README.md` | P2-010 "in `review`" | `tasks/INDEX.md` says `done` |
| 6 | `README.md`, `PLAN.md` | "SMTP email delivery remains a follow-up" | **Ships.** `apps/ingest/src/lib/notify/email.ts`, wired in `index.ts` when `SMTP_HOST`+`SMTP_FROM` are set |
| 7 | `README.md`, `PLAN.md`, `DESIGN_DOC.md`, `docs/PROJECT_OVERVIEW.md` | Phases stop at 9 | **Phase 11 is `done` and Phase 10 is `ready`** in `tasks/INDEX.md`. Four of five status-bearing docs omitted two entire phases — including one that shipped |
| 8 | `DESIGN_DOC.md` | "Last updated: 2026-06-25" | Its own §17 history table ends **2026-07-13** |
| 9 | `OPPORTUNITIES.md` | "Status: pre-roadmap · 2026-06-25" | Body carries July shipping annotations throughout |
| 10 | `docs/PROJECT_OVERVIEW.md` | "68 routes" | 59 `page.tsx`, 74 incl. route handlers. A stale count — and `apps/web/AGENTS.md` *already warns* against restating counts |
| 11 | `apps/web/` | `AGENTS.md` was a stub pointing at the real `CLAUDE.md` | **Inverted vs. the root**, where `CLAUDE.md` symlinks to the real `AGENTS.md`. Now consistent |
| 12 | `AGENTS.md` | "captures Claude Code events", "installs Claude Code hooks" | P8-005 de-Claude-ified the *product*; the agent docs never followed. The adapter seam ships three agents |
| 13 | `AGENTS.md` | Four-gate pre-commit implied CI parity | **CI does not run `bun run build`.** A build break passes CI. Now stated explicitly |

**Pattern worth naming:** items 1–4 and 7 are all *the same fact stated in
several files*, where the update landed in some copies and not others. Item 4 is
the sharpest illustration — a single file contradicted **itself** because §6 and
§8 were updated in different sittings.

---

## 4. Tier 2 — structural recommendations (not applied; your call)

### 4.1 Collapse the status duplication — the highest-value change

Phase/task status is currently asserted in **five** places: `tasks/INDEX.md`,
`README.md`, `PLAN.md`, `DESIGN_DOC.md`'s header, and `docs/PROJECT_OVERVIEW.md`.
`tasks/README.md` already declares `INDEX.md` "the single source of truth."

**Recommendation:** make that declaration real. The other four should carry a
one-line pointer and *no* per-phase status. Roadmap docs describe *intent*, which
is stable; `INDEX.md` tracks *state*, which is not. Today every phase transition
requires five coordinated edits, which is exactly why four of them fell behind.

*Cost:* one afternoon. *Benefit:* removes the single largest drift generator.

### 4.2 Decide what `docs/PROJECT_OVERVIEW.md` is for

It is a good document. It is also ~80% derivable from `DESIGN_DOC.md` +
`OPPORTUNITIES.md` + `tasks/INDEX.md`, and it is the file that drifted hardest —
predictably, because a synthesis of three sources has three ways to go stale.

Options, in preference order:

1. **Keep it, retitle it honestly** — "Snapshot: `main` as of <date>", explicitly
   point-in-time, the way `docs/design/README.md` already frames
   `ui-direction.html`. That framing is exactly right and already exists in this
   repo; reuse it. *(Partially applied — the currency note was strengthened.)*
2. **Fold §§1–4 into `DESIGN_DOC.md`** and delete the rest.
3. Leave as-is and accept the drift.

### 4.3 Add `AGENTS.md` to the workspaces that earn one

Seven of twelve workspaces have no doc of any kind. The ones that would carry
real, non-derivable content:

- **`apps/hook/`** — the adapter seam contract, the <10ms hot-path budget (CI-enforced),
  "hook entrypoints always exit 0," the SQLite/WAL queue invariants. Currently
  buried in a README written for binary *consumers*, not for agents editing the code.
- **`apps/ingest/`** — `loadConfig()` as the only `process.env` reader, the boot
  `HeadBucketCommand`, advisory-locked job scheduling, re-redaction on receipt.
- **`packages/db/`** — the squashed-migration drift trap. This is the sharpest
  footgun in the repo and it is currently documented *only* in the root file,
  where it is loaded into every session including ones that never touch the DB.

**Do not** create these by having an agent summarize each directory — that is
precisely the pattern measured to *reduce* success rates. Write them only where
a real convention or a real trap exists.

### 4.4 Move path-specific rules out of the root file

Per §2, the root file should keep cross-cutting rules and shed anything scoped to
one directory. Candidates for `.claude/rules/` with `paths:` frontmatter, or for
the per-workspace files in §4.3:

| Root content | Better home | `paths:` |
|---|---|---|
| Migrations / runner pattern / schema-change workflow (~25 ln) | `packages/db/AGENTS.md` or a rule | `packages/db/**` |
| Hook CLI distribution + cross-compile targets (~12 ln) | `apps/hook/AGENTS.md` | `apps/hook/**` |
| Storage / MinIO boot check (~4 ln) | `apps/ingest/AGENTS.md` | `apps/ingest/**` |
| "Why each service exists" table | `README.md` — it is orientation for humans, and derivable for agents | — |

That is roughly 45 of 140 lines relocated, leaving a root file that is commands,
gates, and genuinely cross-cutting invariants (Bun-not-Node, schemas-are-truth,
redaction-before-S3, env-validation, agent-neutrality, `/health`).

---

## 5. Tier 3 — cheap automation that stops the drift returning

Every Tier 1 item would have been caught by a check that takes seconds to run.

1. **Markdown link check in CI.** Currently clean — keep it that way. ~15 lines.
2. **Redaction-rule-count assertion.** A test in `packages/redaction` that asserts
   `RULES.length` matches the README table row count. The count has now been wrong
   in four files simultaneously; make it impossible.
3. **`tasks/INDEX.md` ↔ frontmatter consistency check.** `tasks/README.md` already
   anticipates this ("If/when this grows past ~50 active tasks we'll generate it
   from frontmatter"). **There are 96 task files.** That threshold passed a while
   ago — either generate `INDEX.md` or CI-check it against the frontmatter.
4. **Add `bun run build` to CI**, or delete the claim that it is a gate. Right now
   `AGENTS.md` asserts a four-gate contract that CI enforces three-quarters of.

Items 2–4 are each under an hour and each closes a class of error, not an instance.

---

## 6. Tier 4 — the `.claude/` omission

There is no `.claude/` directory. For most repos that is unremarkable; for this
one it is worth a deliberate decision, because the product's entire thesis is that
teams should be able to see and improve how they use coding agents.

Worth considering, in rough value order:

- **`.claude/settings.json` with a permission allowlist** for the read-only
  commands this repo runs constantly (`bun run typecheck`, `bun run check`,
  `bun run test`, `docker compose ps`, `psql -c "SELECT …"`). Removes the most
  frequent prompt friction with no safety loss.
- **A `SessionStart` hook** so Claude Code on the web can bring up the infra stack
  and generate the Prisma client before the first turn. `postinstall` already runs
  `db:generate`; the Docker stack does not come up on its own.
- **Skills over root-file prose** for multi-step procedures. The **schema-change
  reset dance** (`down:v` → `up` → `db:deploy` → `db:seed`) is the textbook case:
  it is a procedure, it is rarely needed, and it currently costs every session
  context whether or not the DB is in scope. The memory docs say this explicitly —
  "If an entry is a multi-step procedure … move it to a skill."
- **A `PreToolUse` hook** as real enforcement for the invariant the docs care most
  about: never write an unredacted transcript to S3. Memory files are context, not
  enforcement; a hook is enforcement. Given that redaction is the load-bearing trust
  guarantee of the whole product, this is the one place where the difference matters.

There is also a dogfooding argument that is not merely cute: the repo generates
exactly the telemetry that would tell you whether any of this helped.

---

## 7. What to leave alone

Worth stating plainly, because "audit" tends to imply "change everything":

- **`DESIGN_DOC.md`** — length is earned. The history table is maintained. Do not
  split it.
- **`apps/web/AGENTS.md`** — the best agent doc here. Specific, scar-derived,
  explicitly warns against restating counts. Do not "clean it up."
- **The task system** — `tasks/README.md` is a real contract, and it is followed.
  The only change worth making is generating `INDEX.md` (§5.3).
- **`docs/runbooks/`, `docs/slos.md`, `docs/on-call.md`** — correctly scoped, no
  drift found.
- **`docs/design/README.md`** — the "point-in-time pitch, not living documentation"
  framing is exactly the right pattern, applied honestly. It is the model §4.2
  should copy.
- **`docs/research/`** — this file's own genre. The HITL assessment retains its
  original reasoning and tags implementation status on top rather than rewriting
  history. Keep doing that.

---

## 8. Recommended order

| Priority | Action | Effort | Kills |
|---|---|---|---|
| **1** | Tier 1 corrections | done | 13 verified errors |
| **2** | §4.1 collapse status to `INDEX.md` | ~half a day | the top drift generator |
| **3** | §5.2–5.4 CI checks + build gate | ~2 hours | three error *classes* |
| **4** | §4.3 `AGENTS.md` for `db` / `hook` / `ingest` | ~half a day | root-file bloat, buried footguns |
| **5** | §5.3 generate `INDEX.md` from frontmatter | ~half a day | hand-maintenance at 96 files |
| **6** | §6 `.claude/` — settings + SessionStart first | ~2 hours | session friction; dogfooding gap |
| **7** | §4.2 decide `PROJECT_OVERVIEW.md`'s role | a conversation | the hardest-drifting file |

---

*Method: full read of all 132 Markdown files; claims cross-checked against source
(`packages/redaction/src/`, `apps/ingest/src/lib/notify/`, `apps/hook/src/adapters/`,
`apps/web/src/app/`, `.github/workflows/ci.yml`, `tasks/INDEX.md`); link integrity
verified by script; best practices from the Claude Code memory documentation and
the 2026 AGENTS.md convention.*
