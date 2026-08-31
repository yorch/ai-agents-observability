# Runbook: Imported History Missing From Dashboards

## Symptoms

- A bulk import (`aiobs import`) finished successfully, sessions are listed on
  `/me/sessions` or `/org/sessions`, but org cost/tool dashboards show little or
  nothing for the imported period.
- `/org/dashboard` cost by team/repo/model, and `/org/tools`, under-report
  against the raw `events` table.
- Widening a date range on those pages adds nothing, while the same range on a
  sessions list clearly has data in it.

Note the near-miss that is **not** this problem: `/me` and `/me/insights` are
trailing-window pages that default to **7 days**. If those look empty right
after an import, check the range selector before reaching for anything here —
imported sessions keep their original timestamps and mostly fall outside 7 days.

## Cause

The three continuous aggregates in
[`packages/db/sql/migrations/0001_init.sql`](../../packages/db/sql/migrations/0001_init.sql)
— `daily_cost_by_user`, `daily_cost_by_model`, `daily_tool_usage` — each carry:

```sql
SELECT add_continuous_aggregate_policy('daily_cost_by_user',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);
```

The background policy therefore only ever refreshes the **trailing 32 days**.
That is right for live telemetry, which always arrives at `now`, and wrong for
imports: `apps/hook`'s import command preserves each transcript's original
timestamps, so the events land months or years in the past, outside the window
the policy will ever touch.

Real-time aggregation does not cover for it. The aggregates are declared
`materialized_only = false`, which unions live rows from the hypertable for the
region **after** the materialization watermark — never before it. Data older
than the watermark that was never materialized simply does not appear.

A second, subtler case has the same cause: writing into a region that *is*
already materialized (a re-import, a late-arriving batch) records a TimescaleDB
invalidation rather than updating the bucket. If that region is older than 32
days, the policy never processes the invalidation and the bucket stays stale
even though the date range looks correct.

## Diagnose

Compare each aggregate's coverage against the raw hypertable:

```bash
docker compose -f docker-compose.infra.yml exec postgres \
  psql -U postgres -d ai_agents_observability -c "
    SELECT 'daily_cost_by_user' AS cagg, count(*) AS buckets, min(day)::date AS oldest, max(day)::date AS newest FROM daily_cost_by_user
    UNION ALL SELECT 'daily_cost_by_model', count(*), min(day)::date, max(day)::date FROM daily_cost_by_model
    UNION ALL SELECT 'daily_tool_usage',    count(*), min(day)::date, max(day)::date FROM daily_tool_usage
    UNION ALL SELECT 'events (raw)',        count(*), min(ts)::date,  max(ts)::date  FROM events;"
```

If the `oldest` for the aggregates is roughly 32 days ago while `events (raw)`
reaches much further back, this is the problem. Example from a deployment right
after importing ~13 months of transcripts:

```
        cagg         | buckets |   oldest   |   newest
 daily_cost_by_user  |      27 | 2026-07-31 | 2026-08-31
 daily_tool_usage    |     366 | 2026-07-31 | 2026-08-31
 events (raw)        |  895971 | 2025-07-17 | 2026-08-31
```

## Fix

**Preferred — trigger the job.** The `refresh-caggs` job
([`apps/ingest/src/jobs/refresh-caggs.ts`](../../apps/ingest/src/jobs/refresh-caggs.ts))
re-materializes all three aggregates over the whole of history. It runs nightly
at 04:00 UTC and can be fired on demand from **/admin/jobs**, or:

```bash
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" \
  http://localhost:4000/admin/jobs/refresh-caggs/run
```

That returns `{ ok: true }` immediately — it only sets `run_requested_at`. The
scheduler polls every 60s, so allow a minute before checking `job_runs`.

**Break-glass — run the SQL directly.** When ingest is down, or you want the
refresh to finish before the next page load:

```bash
bash scripts/refresh-caggs.sh
# on a deployed host, address the container directly:
PG_CONTAINER=ai-agents-observability-postgres-1 bash scripts/refresh-caggs.sh
```

Either path is safe to repeat. Refreshing an already-current range is driven off
the invalidation log, so clean buckets are skipped — on ~900k events the first
full-history pass took 6.6s and an immediate repeat took 85ms.

## Verify

Re-run the diagnose query. The aggregates' `oldest` should now match
`events (raw)`. The two cost aggregates are independent rollups of the same
underlying column, so they are a free cross-check on each other:

```sql
SELECT round(sum(total_cost_usd)::numeric, 2) FROM daily_cost_by_user;
SELECT round(sum(total_cost_usd)::numeric, 2) FROM daily_cost_by_model;
```

These two must agree. If they do not, the refresh did not complete — check
`job_runs` for a `refresh-caggs` row with `status = 'error'`.

## Notes

- `refresh_continuous_aggregate` performs its own transaction control and
  **cannot run inside a transaction block**. That is why this is a job and not a
  numbered SQL migration: `packages/db/src/sql-migrate.ts` wraps every migration
  file in `$transaction`, so a migration containing this CALL would fail.
- The job's window ends at midnight UTC, deliberately leaving today's partial
  bucket to the hourly policy and real-time aggregation.
