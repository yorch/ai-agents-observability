import { type Prisma, scoreUpsertSql } from '@ai-agents-observability/db';
import { buildScoreRow, isEmptyScore, type ScoreInput } from '@ai-agents-observability/schemas';

/**
 * Builds the upsert statement for one score row (P13-001).
 *
 * Upsert rather than insert: re-running a scorer at the same version must be
 * idempotent, because every job that writes scores is re-runnable by design
 * (`POST /admin/jobs/:name/run`, the backfills, the scheduler's own retries).
 * Bumping `scorer_version` writes a *new* row instead of overwriting, so history
 * survives a scorer change and a trend can show the version boundary.
 *
 * The statement itself lives in `packages/db` (`scoreUpsertSql`) because the web
 * app writes human labels through the same conflict target and two hand-written
 * copies of an `ON CONFLICT` clause drift. What stays here is the *policy*: skip
 * the row entirely when the scorer had nothing to say.
 *
 * Returns `null` when the scorer produced nothing — scorers legitimately return
 * null below a minimum-volume threshold, and an empty row would misrepresent
 * "not enough data" as "scored".
 */
export function scoreUpsert(input: ScoreInput): Prisma.Sql | null {
  if (isEmptyScore(input)) {
    return null;
  }
  return scoreUpsertSql(buildScoreRow(input));
}

/** Convenience: the non-null upserts for a batch of scores. */
export function scoreUpserts(inputs: ScoreInput[]): Prisma.Sql[] {
  return inputs.map(scoreUpsert).filter((s): s is Prisma.Sql => s !== null);
}
