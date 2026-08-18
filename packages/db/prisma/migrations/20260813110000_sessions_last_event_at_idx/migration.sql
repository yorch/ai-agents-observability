-- Recency index on `sessions`, for the nightly trajectory scorer walk.
--
-- `compute-trajectory-scores` selects sessions with activity in the last 48
-- hours. It used to keyset-walk the `session_id` primary key, and UUID order has
-- nothing to do with recency — so it read the whole table every night to find a
-- couple of days' worth of rows, and the cost of that grew with the corpus
-- forever. The walk now orders by `(last_event_at, session_id)`; this is the
-- index that makes that a range scan instead of a full scan plus a sort.
--
-- Not covered by the existing `(status, last_event_at)` index: the walk has no
-- status predicate, so it cannot seek on that index's leading column.
--
-- Not partial, unlike the `events` run_kind indexes. The predicate that would
-- narrow it is a moving time window, which cannot be written into an index
-- definition without going stale, and the scorer walk deliberately covers every
-- run kind.
--
-- Forward-only: a new migration rather than a patch to an applied one, so a
-- deployed database picks it up without the reset dance in packages/db/AGENTS.md.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sessions_last_event_at_session_id_idx"
    ON "sessions"("last_event_at", "session_id");
