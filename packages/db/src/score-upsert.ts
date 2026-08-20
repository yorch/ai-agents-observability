import { Prisma } from './generated/client/client';

/**
 * The one `scores` upsert statement in the codebase (P13-001, P13-013).
 *
 * It lives here rather than in either app because there is no longer a Prisma
 * compound-unique input to upsert through. The unique key is
 * `(subject_type, subject_id, scorer_name, scorer_version, period_start)`
 * declared **NULLS NOT DISTINCT** — a modifier Prisma's schema language cannot
 * express — so `prisma.score.upsert` has no generated `where` to offer and both
 * apps write raw SQL. Two hand-written copies of an `ON CONFLICT` clause is
 * exactly the kind of thing that drifts, so there is one.
 *
 * `NULLS NOT DISTINCT` is what makes a single statement serve both shapes. A
 * session score has `period_start = NULL`, and under the default NULL semantics
 * two such rows would not conflict — the upsert every scorer job relies on would
 * quietly become an append, and re-running a job would multiply its rows rather
 * than refresh them.
 *
 * `created_at` is refreshed on update: it means "when this score was last
 * computed", which is what the drift read wants. A periodic row's *identity* is
 * its `period_start`, so refreshing `created_at` cannot blur two windows
 * together.
 *
 * Takes an already-built row rather than a `ScoreInput` so this package needs no
 * runtime dependency on `packages/schemas`. Callers build the row with
 * `buildScoreRow()` there, which is what applies the scorer registry.
 */

/** The shape `buildScoreRow()` produces. Structural, so no import is needed. */
export type ScoreUpsertRow = {
  costUsd: number | null;
  label: string | null;
  metadata: unknown;
  periodEnd?: Date | null;
  periodStart?: Date | null;
  rationaleRef: string | null;
  scorerName: string;
  scorerVersion: number;
  source: string;
  subjectId: string;
  subjectType: string;
  value: number | null;
};

export function scoreUpsertSql(row: ScoreUpsertRow): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO scores (
      id, subject_type, subject_id, scorer_name, scorer_version,
      source, value, label, metadata, rationale_ref, cost_usd,
      period_start, period_end
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
      ${JSON.stringify(row.metadata ?? {})}::jsonb,
      ${row.rationaleRef},
      ${row.costUsd},
      ${row.periodStart ?? null},
      ${row.periodEnd ?? null}
    )
    ON CONFLICT (subject_type, subject_id, scorer_name, scorer_version, period_start)
    DO UPDATE SET
      value         = EXCLUDED.value,
      label         = EXCLUDED.label,
      metadata      = EXCLUDED.metadata,
      rationale_ref = EXCLUDED.rationale_ref,
      cost_usd      = EXCLUDED.cost_usd,
      period_end    = EXCLUDED.period_end,
      created_at    = now()
  `;
}
