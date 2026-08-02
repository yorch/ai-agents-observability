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

## Cost is recomputed, never trusted

The hook computes cost client-side from the versioned price table so price changes
propagate without redeploying binaries. Ingest **recomputes it server-side**
(`src/lib/cost.ts`) against the same table. Client-reported cost is an input, not a
fact. Don't shortcut this by persisting what arrived on the wire.

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
