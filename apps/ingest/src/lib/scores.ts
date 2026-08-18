import { Prisma } from '@ai-agents-observability/db';
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
 * Returns `null` when the scorer produced nothing — scorers legitimately return
 * null below a minimum-volume threshold, and an empty row would misrepresent
 * "not enough data" as "scored".
 */
export function scoreUpsert(input: ScoreInput): Prisma.Sql | null {
  if (isEmptyScore(input)) {
    return null;
  }

  const row = buildScoreRow(input);

  return Prisma.sql`
    INSERT INTO scores (
      id, subject_type, subject_id, scorer_name, scorer_version,
      source, value, label, metadata, rationale_ref, cost_usd
    )
    VALUES (
      gen_random_uuid(),
      ${row.subjectType}::"ScoreSubjectType",
      ${row.subjectId},
      ${row.scorerName},
      ${row.scorerVersion},
      ${row.source}::"ScoreSource",
      ${row.value},
      ${row.label},
      ${JSON.stringify(row.metadata)}::jsonb,
      ${row.rationaleRef},
      ${row.costUsd}
    )
    ON CONFLICT (subject_type, subject_id, scorer_name, scorer_version)
    DO UPDATE SET
      value         = EXCLUDED.value,
      label         = EXCLUDED.label,
      metadata      = EXCLUDED.metadata,
      rationale_ref = EXCLUDED.rationale_ref,
      cost_usd      = EXCLUDED.cost_usd,
      created_at    = now()
  `;
}

/** Convenience: the non-null upserts for a batch of scores. */
export function scoreUpserts(inputs: ScoreInput[]): Prisma.Sql[] {
  return inputs.map(scoreUpsert).filter((s): s is Prisma.Sql => s !== null);
}
