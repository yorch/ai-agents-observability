import type { Prisma, PrismaClient } from '@ai-agents-observability/db';
import {
  buildScoreRow,
  isEmptyScore,
  type ScoreInput,
  type ScorerName,
  type ScoreSource,
  type ScoreSubjectType,
} from '@ai-agents-observability/schemas';

import { getPrisma } from './prisma';

/**
 * The subset of the client these helpers need, so a caller can hand in a
 * `$transaction` client and have a label and the row that records which rubric
 * it answered land together or not at all.
 */
export type ScoreWriteClient = Pick<PrismaClient, 'score'>;

/**
 * Writing `scores` rows from the web app (P13-001 substrate, P13-005 consumer).
 *
 * Scores are normally written by the ingest scheduler, but a *human* label is
 * produced by a person clicking something in the dashboard, so the write happens
 * here. Same substrate, same idempotency: upsert on
 * `(subject_type, subject_id, scorer_name, scorer_version)`, so re-answering the
 * rubric corrects the label in place while a rubric **version** bump writes a new
 * row and leaves the old answer intact as history.
 *
 * The scorer name, source, subject type and version all come from the registry in
 * `packages/schemas` — never spelled out at a call site — so a rubric version bump
 * lands everywhere at once and cannot be half-applied.
 *
 * Prisma's model API rather than raw SQL: ingest builds `Prisma.Sql` because it
 * batches hundreds of upserts into one transaction, which nothing here needs.
 */
export async function upsertScore(
  input: ScoreInput,
  client: ScoreWriteClient = getPrisma(),
): Promise<void> {
  if (isEmptyScore(input)) {
    // A scorer with nothing to say writes no row — an empty row would
    // misrepresent "not answered" as "answered".
    return;
  }
  const row = buildScoreRow(input);
  await client.score.upsert({
    create: {
      costUsd: row.costUsd,
      label: row.label,
      metadata: row.metadata as Prisma.InputJsonValue,
      rationaleRef: row.rationaleRef,
      scorerName: row.scorerName,
      scorerVersion: row.scorerVersion,
      source: row.source,
      subjectId: row.subjectId,
      subjectType: row.subjectType,
      value: row.value,
    },
    update: {
      costUsd: row.costUsd,
      createdAt: new Date(),
      label: row.label,
      metadata: row.metadata as Prisma.InputJsonValue,
      rationaleRef: row.rationaleRef,
      value: row.value,
    },
    where: {
      subjectType_subjectId_scorerName_scorerVersion: {
        scorerName: row.scorerName,
        scorerVersion: row.scorerVersion,
        subjectId: row.subjectId,
        subjectType: row.subjectType,
      },
    },
  });
}

/**
 * Removes a score at the *current* registry version for one subject — used when
 * a human retracts a label they previously gave. Only the current version is
 * touched: an answer to an older rubric version is a historical fact about a
 * question that is no longer being asked, and retracting today's answer is not a
 * statement about it.
 */
export async function deleteScore(
  scorerName: ScoreInput['scorerName'],
  subjectId: string,
  client: ScoreWriteClient = getPrisma(),
): Promise<void> {
  const row = buildScoreRow({ scorerName, subjectId });
  await client.score.deleteMany({
    where: {
      scorerName: row.scorerName,
      scorerVersion: row.scorerVersion,
      subjectId: row.subjectId,
      subjectType: row.subjectType,
    },
  });
}

/**
 * Reading `scores` — the one place a score row is fetched from, and the place
 * the judge-exposure rule is a property of the code rather than of review.
 *
 * P13-009's rule is that a judge's label about one person's work is visible to
 * that person and to nobody else, until P13-010 has calibrated it and P13-011
 * has taken the exposure decision with developers consulted. Until this
 * accessor existed, the rule was enforced only by a source-level lint that
 * matches the *scorer names* (`test/judge-owner-only.test.ts`) — which a query
 * written as `where: { source: 'JUDGE' }` walks straight past. That is not
 * hypothetical: `getJudgeSpend` is already written exactly that way.
 *
 * So the read path itself refuses. A judge row's `label` and `rationale_ref`
 * come back only when the caller supplies an owner id **that this function
 * verifies against `sessions.user_id`** — not a caller's assertion that it
 * checked, an ownership query made here. Everything else gets the
 * aggregate-only view, whose return type has no `label` and no `rationaleRef`
 * to read, so "I'll just sum the costs" cannot quietly become "and show the
 * verdicts" in a later edit.
 *
 * The lint stays as a second line of defence: this stops the un-owned *read*,
 * and the lint still catches a new module going looking in the first place.
 */

/** A score row as read back. `label`/`rationaleRef` are the sensitive halves. */
export type ScoreRow = {
  costUsd: number | null;
  createdAt: Date;
  label: string | null;
  metadata: Prisma.JsonValue;
  rationaleRef: string | null;
  scorerName: string;
  scorerVersion: number;
  source: string;
  subjectId: string;
  subjectType: string;
  value: number | null;
};

/**
 * What an unowned read is allowed to see: the same row with the judgement taken
 * out. Not a runtime convention — the two fields are absent from the type, so a
 * caller cannot read what it was not given.
 */
export type AggregateScoreRow = Omit<ScoreRow, 'label' | 'rationaleRef'>;

export type ScoreQuery = {
  scorerNames?: readonly ScorerName[];
  since?: Date;
  source?: ScoreSource;
  subjectIds?: readonly string[];
  subjectType?: ScoreSubjectType;
};

/**
 * Who is asking.
 *
 * - `owner` — reading one person's own scores. Judge labels are returned only
 *   for sessions this function confirms that person owns; any other judge row
 *   is dropped from the result rather than half-returned.
 * - `aggregate-only` — the sanctioned exception, for reads that are about
 *   *volume or money* and never about a verdict. `reason` is required so the
 *   exception is argued for at the call site and visible in a diff.
 */
export type ScoreAccess =
  | { kind: 'aggregate-only'; reason: string }
  | { kind: 'owner'; ownerUserId: string };

function buildWhere(query: ScoreQuery): Prisma.ScoreWhereInput {
  return {
    ...(query.scorerNames ? { scorerName: { in: [...query.scorerNames] } } : {}),
    ...(query.since ? { createdAt: { gte: query.since } } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.subjectIds ? { subjectId: { in: [...query.subjectIds] } } : {}),
    ...(query.subjectType ? { subjectType: query.subjectType } : {}),
  };
}

export async function readScores(
  query: ScoreQuery,
  access: { kind: 'owner'; ownerUserId: string },
): Promise<ScoreRow[]>;
export async function readScores(
  query: ScoreQuery,
  access: { kind: 'aggregate-only'; reason: string },
): Promise<AggregateScoreRow[]>;
export async function readScores(
  query: ScoreQuery,
  access: ScoreAccess,
): Promise<AggregateScoreRow[] | ScoreRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.score.findMany({
    orderBy: [{ scorerVersion: 'desc' }, { scorerName: 'asc' }],
    where: buildWhere(query),
  });

  const toRow = (r: (typeof rows)[number]): ScoreRow => ({
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
    createdAt: r.createdAt,
    label: r.label,
    metadata: r.metadata,
    rationaleRef: r.rationaleRef,
    scorerName: r.scorerName,
    scorerVersion: r.scorerVersion,
    source: r.source,
    subjectId: r.subjectId,
    subjectType: r.subjectType,
    value: r.value === null ? null : Number(r.value),
  });

  if (access.kind === 'aggregate-only') {
    // Strip on the way out, for every row rather than only the judge's: a
    // caller that declared it wants aggregates has no business with any label,
    // and a rule with an exception list is a rule waiting to be widened.
    return rows.map((r) => {
      const { label: _label, rationaleRef: _ref, ...rest } = toRow(r);
      return rest;
    });
  }

  const judgeRows = rows.filter((r) => r.source === 'JUDGE');
  if (judgeRows.length === 0) {
    return rows.map(toRow);
  }

  // Ownership is proved here, by query. A judge label is only ever about a
  // SESSION, so a judge row on any other subject type cannot be owner-checked
  // and is therefore not returnable.
  // run-kind-exempt: an ownership probe over named session ids, not a
  // population — filtering it would hide a user's own CI session's scores.
  const owned = await prisma.session.findMany({
    select: { sessionId: true },
    where: {
      sessionId: { in: [...new Set(judgeRows.map((r) => r.subjectId))] },
      userId: access.ownerUserId,
    },
  });
  const ownedIds = new Set(owned.map((s) => s.sessionId));

  return rows
    .filter(
      (r) => r.source !== 'JUDGE' || (r.subjectType === 'SESSION' && ownedIds.has(r.subjectId)),
    )
    .map(toRow);
}
