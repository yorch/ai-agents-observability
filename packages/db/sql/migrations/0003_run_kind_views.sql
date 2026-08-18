-- P13-012 — the `run_kind` guard, expressed once instead of remembered ~140 times.
--
-- Before this, every human-facing read carried a `run_kind = 'INTERACTIVE'`
-- fragment from `apps/web/src/lib/run-kind.ts`, and two source-scanning lints
-- counted them. That worked, and the history says it worked the way a rule at
-- the wrong altitude works: the predicate was inline and drifted (org spend
-- reported 121 sessions / $547.83 against a true 115 / $19.03); centralizing it
-- found 18 SQL and 22 ORM sites that had never adopted it; counting per literal
-- then found seven guards bound to a CTE while the driving query ran unfiltered;
-- and the ingest alert engine still had two unguarded `events` reads that no
-- lint could see, because that app had no counting lint at all.
--
-- Four rounds, each finding sites the previous round's mechanism could not.
-- A view ends that: a query either reads the filtered relation or it names the
-- base table, and naming the base table is the visible, greppable exception.
--
-- Cost check, done before committing to this: the planner **inlines** a simple
-- view, so TimescaleDB chunk exclusion is unaffected. `EXPLAIN` on
-- `interactive_events` and on the equivalent filtered `events` query produce
-- byte-identical plans — same ChunkAppend, same index choice, 3 of 30 chunks
-- scanned either way.
--
-- `SELECT *` is deliberate. These views must track their base tables as columns
-- are added — `events` in particular gains columns regularly — and an explicit
-- column list would silently stop exposing anything new.

CREATE OR REPLACE VIEW interactive_sessions AS
  SELECT * FROM sessions WHERE run_kind = 'INTERACTIVE';

CREATE OR REPLACE VIEW interactive_events AS
  SELECT * FROM events WHERE run_kind = 'INTERACTIVE';

COMMENT ON VIEW interactive_sessions IS
  'Sessions a human actually had (P13-012). Read this, not `sessions`, from anything that reports on people. Reading the base table is the documented exception and needs a run-kind-exempt marker at the call site.';

COMMENT ON VIEW interactive_events IS
  'Events from sessions a human actually had (P13-012). Read this, not `events`, from anything that reports on people. The planner inlines the view, so hypertable chunk exclusion is unaffected.';
