# apps/ingest — agent notes

> `CLAUDE.md` here is a symlink to this file. Edit `AGENTS.md`.
>
> **Root rules still apply.** Claude Code concatenates this file with the repo-root
> [`AGENTS.md`](../../AGENTS.md); some other agents load only the *nearest* file.
> The invariants most expensive to lose are restated here for that case:
> four gates before every commit (`bun run check` → `typecheck` → `build` → `test`);
> `packages/schemas` is the only source of telemetry event shapes; and **transcripts
> pass `packages/redaction` before any S3 write** — see "Redaction is not optional".

Hono on `Bun.serve` (:4000). Two jobs: take telemetry off the wire, and run the
scheduled work. Stateless per-request; all state is Postgres/Timescale + S3.

## Routes

`src/routes/` — `events.ts` (`POST /v1/events`, idempotent batch), `transcripts.ts`
(`POST /v1/transcripts/:id`, chunked), `price-table.ts` (`GET /v1/price-table?agent=`,
per-agent + versioned, ETag'd), `admin.ts` (`POST /admin/jobs/:name/run`).
`/health`, `/readyz`, `/metrics` are public and do no DB work.

## Redaction is not optional

Transcripts are redacted **twice**: once client-side in the hook, and again here on
receipt (`src/lib/transcript-pipeline.ts`). The second pass is deliberate — the server
does not trust that the client ran. Nothing writes to S3 without going through it.

If you add an endpoint that accepts user-pasted content, it either goes through the
pipeline or it doesn't ship. New content shapes need their own rule in
`packages/redaction`, not a local regex here.

**`events.metadata` is the surface that is not redacted, and cannot be.** It is a
JSONB column written straight through by `lib/insert-events.ts`; running the
transcript pipeline over it would be the wrong tool anyway, since redaction scrubs
secrets, not prose. So the rule is exclusion, applied at capture — and applied
*again* here, because the hook is a binary developers upgrade on their own
schedule and an un-upgraded machine keeps sending the old shape. `insertEventsBatch`
runs `stripContentBearingKeys()` (`packages/schemas/src/metadata-safety.ts`) over
every incoming metadata object: the NAME half of the rule only, never the shape half
— that one refuses arrays, and `metadata.tool_use_ids` is a legitimate derived array
the turn-linkage join depends on. `test/metadata-content-strip.test.ts` pins both
directions (P14-008).

## Transcripts are re-shipped, and must re-store

Agents ship a **growing** transcript: Claude Code on every Stop, opencode on every
session-idle. `POST /v1/transcripts/:id` therefore receives the same session many
times, each upload longer than the last, all at the same deterministic S3 key.

Skipping on "an object already exists at that key" froze every session's transcript
at whatever its first turn contained — silently, with a 200 and a matching
"uploaded" log line on the client. The skip is now gated on the **upload's sha256**,
stamped onto the object as user metadata when it was stored, so an identical
re-ship short-circuits and a grown one replaces. Size is NOT a usable signal here:
what we store is the server's re-redacted recompression, whose length has nothing
to do with the client's compressed upload.

## Cost is computed here, and only here

Every adapter emits `cost_usd: 0`; `src/lib/cost.ts` computes the real number on
receipt, against the versioned per-agent table in `src/data/`. A price correction is
therefore a JSON edit plus a restart — no hook redeploy. Client-reported cost is an
input, not a fact: don't shortcut this by persisting what arrived on the wire, even
if a future adapter starts sending a real figure.

**`computeCostUsd` assumes four *disjoint* token counts.** That is Anthropic's
convention — its `input_tokens` excludes both cache counters. OpenAI and Google
report the opposite: one inclusive prompt total with the cached tokens *inside* it.
Normalizing that is the **adapter's** job (`codex.ts`, `gemini-cli.ts` both subtract
before emitting), so this function stays agent-neutral. If you find yourself adding
an `if (agent === …)` here, the adapter is doing too little.

The one fallback the lookup does make is stripping a leading `<provider>/` on a
miss, so `anthropic/claude-opus-5` from an OpenRouter-style agent prices as
`claude-opus-5`. Exact keys still win, so a table can price a prefixed name
differently by listing it verbatim.

A model with no row bills `$0` and is recorded in `unknown_model_events_total`,
namespaced `<agent>:<model>`. The `unknown_model_surge` alert names the models
(a bare count leaves the operator grepping these logs), and `/admin/price-tables`
lists them with their traffic. Watch those rather than assuming silence means
correctness.

**Correcting a table does not correct history.** `events.cost_usd` is written once,
at ingest. `reprice-events` (below) is what fixes already-stored rows, and it has
to move `sessions.total_cost_usd`, `pr_rollups.total_cost_usd` and the two cost
continuous aggregates with it — the session total is *accumulated* at ingest, never
recomputed, so it will not drift back into agreement on its own.

**Copilot's table is empty on purpose**: Copilot bills premium requests against a
seat allowance, not tokens, so there is no honest per-mtok row to write.

## Two kinds of price table

**Hand-maintained, from one vendor's own pricing page** — `claude_code`, `codex`,
`gemini_cli`. Single vendor, single source, and the page carries what a catalog
flattens away: promotional windows with expiry dates, per-tier rates, cache-write
multipliers. Edit these by hand and cite the page and retrieval date in `_comment`.

**Generated from models.dev** — `pi`, `omp`, `opencode`. These three drive whatever
provider the user holds credentials for, so their tables are a *union* across
twenty vendors, and a union hand-maintained from twenty pages goes stale the week
it lands. models.dev is the catalog opencode itself builds its model list from, so
the keys are by construction the names the adapter reports — a correct rate filed
under a name the agent never emits prices nothing. Refresh with:

```bash
bun run gen:price-tables            # or --from ./api.json for a pinned snapshot
```

Do not hand-edit those three; the next regeneration overwrites you. The one
sanctioned override lives in `scripts/gen-price-tables.ts` (`VENDOR_OVERRIDES`) and
exists for exactly one thing a catalog cannot carry: a promotional rate with an
expiry date. A test asserts the generated tables agree with the hand-maintained
ones on every shared model, so an unlisted disagreement fails the suite rather
than pricing the same model two ways depending on which agent ran it.

## Every base-table read says why it sees all runs

Sessions and events carry a `run_kind` (`INTERACTIVE` | `CI` | `EVAL`). The filtered
views `interactive_sessions` / `interactive_events` (in
`packages/db/sql/migrations/0001_init.sql`) carry the guard, so a query gets it by
naming the view rather than by remembering a predicate.

Ingest is the app where **most** reads are legitimately exempt — retention sweeps,
transcript indexing, redaction backfill, per-session scoring and repricing all operate
on rows rather than on people, and a job that skipped non-interactive rows would leave
them permanently unswept, unindexed or mispriced. `src/lib/run-kind.ts` records the
three classes: row-operations, per-session scorers, and comparisons against an
unfiltered external ground truth (`reconcile-cost` sums against a vendor invoice that
bills every token, so filtering would manufacture a permanent drift).

That inverts what is worth checking. Counting guards proves nothing here; the
interesting claim is the *exemption*. So any `FROM`/`JOIN`/`UPDATE` naming a base table
must carry a `run-kind-exempt: <why>` comment within twelve lines, and
`test/run-kind-fragment.test.ts` fails without one. Write the actual reason — a reader
should be able to check it against the query.

The alert engine is the exception that keeps its own stricter rule: every evaluator
there answers "is this org's people-driven usage going wrong?", so **no** read in
`jobs/evaluate-alerts.ts` may name a base table at all. That rule exists because two of
its seven reads once didn't have the guard while the other five did, so
`unknown_model_surge` and `routing_waste` counted machine traffic and `spend_spike` and
`budget_threshold` did not. Nothing failed; the numbers were just wrong in one
direction.

The app-wide half of the lint was added after the `reprice-events` job landed reading
and writing both base tables with nothing to flag it — the earlier check was scoped to
`evaluate-alerts.ts` alone, which is precisely the shape of lint that cannot see the
file you didn't think of.

## Boot fails loud

`src/index.ts` runs a `HeadBucketCommand` at startup to prove the bucket exists and the
credentials work. A misconfigured object store is a startup failure, not a 500 an hour
later when the first transcript lands. Keep that property when you touch boot.

Same principle for config: `src/config.ts`'s `loadConfig()` is the **only** place in
this app that reads `process.env`, and it's Zod-validated. Missing config kills the
process at boot. Don't reach for `process.env` in a handler.

Optional subsystems stay optional by *config presence*, not by flag — the SMTP alert
channel wires up only when `SMTP_HOST` and `SMTP_FROM` are both set
(`src/lib/notify/email.ts`); Slack and generic webhook are always available.

## Scheduled jobs

`src/jobs/`, dispatched by `scheduler.ts` against the `job_config` table with runs
recorded in `job_runs`. Registered: `sync-teams`, `sync-jira`, `sweep-abandoned`,
`sweep-scratch`, `run-deletions`, `sweep-retention`, `index-transcripts`,
`compute-effectiveness`, `compute-effectiveness-backfill`,
`compute-trajectory-scores`, `compute-subject-scores`, `link-turn-events`,
`compute-cost-attribution`,
`evaluate-alerts`,
`backfill-redaction`, `reconcile-cost`, `reprice-events` / `reprice-events-apply`,
`judge-sessions`, plus the two operator-triggered rescore entries
`rescore-effectiveness` and `rescore-trajectory`. (`alert-transition` and
`anthropic-billing-source` are collaborators, not scheduled entries.)

**`judge-sessions` is the one job that reads conversation content with a model**
(P13-009), and it is off in three independent ways: seeded `enabled = false`,
wired only when `JUDGE_ANTHROPIC_API_KEY` **and** `JUDGE_OPERATOR_USER_ID` are
both set, and restricted to sessions whose owner set `allow_judge_analysis`.
The own-sessions restriction is a **code constant** (`JUDGE_OWN_SESSIONS_ONLY`),
not an env var, so no deployment configuration can aim it at a third party —
lifting it is [`P13-011`](../../tasks/P13-011-arm-judge-for-other-users.md).
Both guards are re-evaluated immediately before each fetch, every read writes an
`AuditLog` row visible to the subject, and the judge is sent no tools. If you
touch this job, keep those properties: `test/judge-sessions.test.ts` asserts
that removing either guard alone still blocks a third party's transcript.

**Scorer jobs write `scores` rows, never `sessions` columns** — except
`compute-effectiveness`, which predates the substrate and still maintains the
denormalized `friction_score` / `shape_label` cache alongside its score rows.
Their idempotency comes from the upsert on
`(subject_type, subject_id, scorer_name, scorer_version, period_start)` — declared
`NULLS NOT DISTINCT`, so a session score's NULL period still conflicts with itself
rather than appending (P13-013) — so re-running one is free; bumping a scorer version in `packages/schemas/src/scores.ts` and triggering
`rescore-effectiveness` / `rescore-trajectory` re-scores history without a
bespoke backfill job. Those two rescore entries are operator-triggered only and
deliberately absent from `CONFIGURABLE_JOBS`.

**Wrap new jobs in `withJobRun()`** (`src/jobs/job-run.ts`). It takes
`pg_try_advisory_lock(hashtext('job:<name>'))`, skips the run with a warning if it
can't get the lock, and records the `job_runs` row. The stack is single-instance
today; the locking is what keeps that from being an assumption.

`embed-transcripts` is a gated prototype and is **not scheduled** (P7-007 no-go).
Leave it that way unless the semantic-search decision is revisited.

**Three tiers, and they are not interchangeable.** `CONFIGURABLE_JOBS` is the set with
an editable hour+minute cadence in `job_config` (`sweep-retention`,
`index-transcripts`, `compute-effectiveness`, `compute-trajectory-scores`,
`compute-subject-scores`, `link-turn-events`, `compute-cost-attribution`,
`evaluate-alerts`,
`judge-sessions`); the scheduler DB-polls
those every 60s. `ALL_KNOWN_JOBS` adds the fixed-timer and operator-drain jobs that
`POST /admin/jobs/:name/run` accepts (`sync-teams`, `sync-jira`, `sweep-abandoned`,
`sweep-scratch`, `run-deletions`, `backfill-redaction`, `reprice-events`,
`reprice-events-apply`). Everything else `triggerJob()` can dispatch is **deliberately
unreachable over HTTP** — `compute-effectiveness-backfill`, `rescore-effectiveness`,
`rescore-trajectory` and `reconcile-cost` are dispatchable only from in-process code
(an operator script, or `reconcile-cost`'s own daily timer when
`billingReconciliationEnabled`). Adding a job to the enum is not what makes it
triggerable; adding it to `ALL_KNOWN_JOBS` is. For the tiers it does cover, the manual
trigger is the supported way to exercise a job, rather than shortening its schedule.

**`compute-cost-attribution` writes two columns that must never be added
together.** Real spend accrues per assistant *turn*; `events.cost_usd` lands on
the `Stop` event and the tool rows that turn issued are priced at nothing. The
job redistributes that for display, into `events.attributed_cost_usd` (the
issuing turn's cost split evenly across the `PostToolUse` events it issued) and
`events.downstream_cost_usd` (the *following* turn's input-side cost apportioned
by `tool_output_bytes`). Those are **two lenses on the same dollars** — turn N+1
appears once as its own tools' issuing share and again as turn N's tools'
downstream inflation — so summing them double-counts, and neither may feed
`sessions.total_cost_usd`, `pr_rollups.total_cost_usd` or the cost caggs, which
already count these dollars once. The arithmetic is a pure function in
**`packages/schemas/src/cost-attribution.ts`** precisely so the definitions have
tests; the job is the plumbing. It lives in `packages/schemas` rather than here
because `packages/db/src/seed.ts` writes the same two columns for the demo
database and cannot depend on this app (P14-011) — a seed that recomputed the
arithmetic locally is the defect Phase 14 exists to remove. If you change a
definition, you are changing what both the demo database and production show;
`packages/schemas/src/cost-attribution.test.ts` is where it is pinned. NULL means
*not attributed*, never $0.00 — a session with no `turn_number` linkage gets
nothing, which is why the dashboards show a coverage indicator rather than a
confident zero.

**`link-turn-events` is what fills that linkage in for live sessions, and it must
run first** (P14-006). It is scheduled at 06:10, immediately before the
attribution job at 06:15, because attribution selects on the very columns this
one writes; inverting them costs a full day of coverage. It joins a live tool
event to its issuing turn on `(session_id, tool_use_id)` — a **natural key**, not
a timestamp guess: Claude Code's tool-hook payload carries `tool_use_id`, and the
Stop the hook derives from the transcript lists the ids that turn issued under
`metadata.tool_use_ids`. Both halves are already rows in `events` by the time the
job runs, so it reads no transcript and no S3 object.

Three properties to keep if you touch it. It writes **only** `turn_number` and
`parent_event_id`, and only where `turn_number IS NULL` — an imported session's
captured linkage can never be overwritten by a derived one. It consults **no
clock**; a `ts`-nearest-Stop heuristic is the thing this replaced, and its failure
mode was a plausible dollar figure on the wrong tool. And an id no Stop claims
stays NULL and is counted into the run's `unresolvedIds`, so the residue is
visible rather than guessed at.

The definition lives in `src/lib/turn-linkage.ts` as a pure function, for the same
reason `cost-attribution.ts` does (it stays app-local because ingest is its only
caller). It restates one string — `TOOL_USE_IDS_METADATA_KEY` — that `apps/hook`
also declares; ingest cannot import
from the hook, so `test/turn-linkage.test.ts` reads the hook's source as text and
fails if the two drift. Without that, a rename on either side leaves the join
silently matching nothing.

Unlike `reprice-events` it needs **no report/apply interlock**: it assigns a
derived value rather than rewriting a measured one, is a pure function of the
stored rows, and re-running is a no-op.

**`routing_waste` reads that attributed column, and could not read anything
else.** Until P14-005 the evaluator joined its downgradeable `(agent, model,
category)` triples against `e.model` on a row already restricted to
`event_type = 'PostToolUse'`. No producer puts a model on a tool row —
`events.model` comes from an event's `llm` block and every adapter attaches that
to a `Stop` — so the alert was armed, enabled and permanently silent, its
arithmetic exercised only against seeded data. It now reaches the model through
the issuing turn (`turn.event_id = tool.parent_event_id`) and sums the tool row's
`attributed_cost_usd`, and it carries `attributedCalls` / `callCount` in
`details` so a fired alert says how much of the window it could measure. If you
add a query that asks a tool row about a model, you are writing a dead query.

**`reprice-events` is two job names on purpose.** The bare name reports what
repricing would change; `reprice-events-apply` writes it. The trigger endpoint
takes no request body, so a `dryRun` flag had nowhere to live — and rewriting
historical cost by default is not a mistake worth making available. Each name
takes its own advisory lock (`withJobRun` derives it from the job name), so two
applies cannot overlap — but a report started mid-apply will describe a partly
repriced table. Read the report, then apply; not the other way round.
