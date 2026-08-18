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
namespaced `<agent>:<model>`. That metric is the signal to extend a table — watch it
rather than assuming silence means correctness. **Copilot's table is empty on
purpose**: Copilot bills premium requests against a seat allowance, not tokens, so
there is no honest per-mtok row to write.

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
recorded in `job_runs`. Twelve are registered: `sync-teams`, `sync-jira`,
`sweep-abandoned`, `sweep-scratch`, `run-deletions`, `sweep-retention`,
`index-transcripts`, `compute-effectiveness`, `compute-effectiveness-backfill`,
`evaluate-alerts`, `backfill-redaction`, `reconcile-cost`. (`alert-transition` and
`anthropic-billing-source` are collaborators, not scheduled entries.)

**Wrap new jobs in `withJobRun()`** (`src/jobs/job-run.ts`). It takes
`pg_try_advisory_lock(hashtext('job:<name>'))`, skips the run with a warning if it
can't get the lock, and records the `job_runs` row. The stack is single-instance
today; the locking is what keeps that from being an assumption.

`embed-transcripts` is a gated prototype and is **not scheduled** (P7-007 no-go).
Leave it that way unless the semantic-search decision is revisited.

Any job can be triggered manually via `POST /admin/jobs/:name/run` — that's the
supported way to exercise one, rather than shortening its schedule.
