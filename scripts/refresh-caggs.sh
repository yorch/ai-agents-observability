#!/usr/bin/env bash
# Re-materialize the three TimescaleDB continuous aggregates over all history.
#
# This is the BREAK-GLASS path. The normal way to do this is the `refresh-caggs`
# job (nightly at 04:00 UTC, and triggerable on demand from /admin/jobs) — use
# this script when ingest is down, when you have just finished a bulk import and
# do not want to wait, or when you are diagnosing the aggregates themselves.
#
# Why it is ever needed: each aggregate's policy carries
# `start_offset => INTERVAL '32 days'`, so the background refresh only ever
# covers the trailing 32 days. Imported sessions keep their original timestamps
# and therefore land outside that window — invisible to every cagg-backed
# dashboard until something refreshes them. See
# docs/runbooks/cagg-backfill.md for the full explanation.
#
# Safe to re-run: refreshing an already-current range is driven off Timescale's
# invalidation log, so clean buckets are skipped (~85 ms for a no-op pass over
# ~900k events).
#
# Usage:
#   bash scripts/refresh-caggs.sh                 # dev stack (docker-compose.infra.yml)
#   COMPOSE_FILE=docker-compose.prod.yml bash scripts/refresh-caggs.sh
#   PG_CONTAINER=ai-agents-observability-postgres-1 bash scripts/refresh-caggs.sh

set -euo pipefail

CAGGS=(daily_cost_by_user daily_cost_by_model daily_tool_usage)

# Everything from the beginning of time up to midnight UTC today. The current
# day's bucket is deliberately left alone: materializing a partial bucket would
# freeze it until the next refresh, whereas real-time aggregation serves it live
# and correct. This mirrors runRefreshCaggs() in apps/ingest/src/jobs/.
END="$(date -u +%Y-%m-%dT00:00:00Z)"

# Two ways to reach the database: a named container (set PG_CONTAINER, which is
# what you want on a deployed host) or compose service resolution (the default,
# for a local stack).
if [[ -n "${PG_CONTAINER:-}" ]]; then
  psql_exec() { docker exec -i "$PG_CONTAINER" sh -c "$1"; }
else
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.infra.yml}"
  cd "$(git rev-parse --show-toplevel)"
  psql_exec() { docker compose -f "$COMPOSE_FILE" exec -T postgres sh -c "$1"; }
fi

echo "Refreshing continuous aggregates through ${END}"

for cagg in "${CAGGS[@]}"; do
  echo "  → ${cagg}"
  psql_exec "psql -v ON_ERROR_STOP=1 -q -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" \
    -c \"CALL refresh_continuous_aggregate('${cagg}', NULL, '${END}');\""
done

echo
echo "Coverage after refresh:"
psql_exec "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"
  SELECT 'daily_cost_by_user' AS cagg, count(*) AS buckets, min(day)::date AS oldest, max(day)::date AS newest FROM daily_cost_by_user
  UNION ALL SELECT 'daily_cost_by_model', count(*), min(day)::date, max(day)::date FROM daily_cost_by_model
  UNION ALL SELECT 'daily_tool_usage',    count(*), min(day)::date, max(day)::date FROM daily_tool_usage
  UNION ALL SELECT 'events (raw)',        count(*), min(ts)::date,  max(ts)::date  FROM events;\""
