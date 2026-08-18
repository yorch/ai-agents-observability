# Runbook: `daily_cost_by_user` History Gap After 0008

## Background

`packages/db/sql/migrations/0008_caggs_interactive_only.sql` redefines the
`daily_cost_by_user` continuous aggregate (`DROP MATERIALIZED VIEW ... CASCADE`
followed by `CREATE MATERIALIZED VIEW ... WITH NO DATA`) to add a
`run_kind = 'INTERACTIVE'` filter. This is a **one-time, forward-only**
migration (see `packages/db/AGENTS.md`) — it runs once per environment, the
first time that environment deploys past 0008.

The DROP destroys the view's previously materialized buckets. The recreated
view's continuous-aggregate policy only ever materializes a rolling
`start_offset => INTERVAL '32 days'` window going forward. Once the policy's
background worker has advanced its watermark, buckets **older than 32 days**
are covered by neither the (now-empty, pre-32-day) materialized data nor
real-time aggregation (which only covers the region above the watermark) —
they silently disappear from every reader of the view, with no error.

## Who is affected

Any environment that (a) had `daily_cost_by_user` data older than 32 days
*before* deploying 0008, and (b) is read by:

- `apps/web/src/lib/org-queries.ts` — cost-by-team, cost-by-user, org cost
  trend (used on the org dashboard and stakeholder views).

A fresh environment with no history older than 32 days at deploy time is not
affected — there is nothing to lose.

## Symptoms

- Org cost dashboards / cost-by-team / cost-by-user show a hard cutoff: no
  cost data before roughly "32 days before whenever the cagg policy first ran
  after the 0008 deploy," even though older `events` rows still exist.
- `SELECT count(*) FROM daily_cost_by_user WHERE day < now() - interval '32 days'`
  returns 0 (or far fewer rows than `events` has for that range).

## Fix

Run once, immediately after deploying 0008, with direct DB access:

```bash
docker compose -f docker-compose.infra.yml exec postgres \
  psql -U postgres -d ai_agents_observability \
  -c "CALL refresh_continuous_aggregate('daily_cost_by_user', NULL, NULL);"
```

Passing `NULL` for both bounds re-materializes the view's entire history from
the raw `events` hypertable. This cannot be folded into the migration file
itself — `refresh_continuous_aggregate()` cannot run inside a transaction
block, and `sql-migrate.ts` applies every migration file inside one.

The call can take a while on a large `events` table (it walks every chunk);
it is safe to run against a live system — it only reads `events` and rewrites
the cagg's internal materialized hypertable.

## Verify

```sql
SELECT count(*) FROM daily_cost_by_user WHERE day < now() - interval '32 days';
```

Compare against a raw count for the same window from `events` (adjust the
grouping to match what you expect):

```sql
SELECT count(DISTINCT date_trunc('day', ts)) FROM events
WHERE run_kind = 'INTERACTIVE' AND ts < now() - interval '32 days';
```

If the cagg count is still 0 (or far below the raw signal) after the refresh,
escalate — do not assume the gap closed without checking.

## Escalate

If cost history for a real org has already been silently missing for a
period before this was caught, flag it to the team lead — reports generated
from the dashboard during the gap window may need to be corrected once the
refresh completes. See [on-call.md](../on-call.md).
