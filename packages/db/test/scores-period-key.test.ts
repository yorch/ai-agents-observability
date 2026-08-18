import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The `scores` uniqueness rule lives in SQL, not in `schema.prisma`, because
 * Prisma cannot express `NULLS NOT DISTINCT` (P13-013). That means nothing in
 * the type system or the generated client mentions it, and if the file stopped
 * declaring it the failure would be invisible: inserts would keep succeeding,
 * and duplicate score rows would accumulate silently until someone noticed a
 * dashboard double-counting.
 *
 * So this reads the migration as text, the same way `agent-type-parity.test.ts`
 * does and for the same reason — Prisma's name-based idempotency check cannot
 * see inside an applied migration either.
 */

const MIGRATION = join(import.meta.dirname, '../sql/migrations/0001_init.sql');

describe('the scores period key', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('declares the unique index NULLS NOT DISTINCT', () => {
    // Without this modifier every NULL period is distinct, so two rows for the
    // same non-periodic score both insert — turning the upsert every scorer job
    // relies on into an append.
    expect(sql).toMatch(/NULLS NOT DISTINCT/);
  });

  it('keys on the period as well as the scorer', () => {
    expect(sql).toMatch(
      /\(subject_type,\s*subject_id,\s*scorer_name,\s*scorer_version,\s*period_start\)/,
    );
  });

  it('is the only unique index on scores', () => {
    // Post-squash there is no 4-column predecessor to drop — it never existed
    // on a fresh install, because `schema.prisma` carries no @@unique. A DROP
    // here would now be dead code implying a migration path that is gone.
    expect(sql).not.toMatch(/scores_subject_type_subject_id_scorer_name_scorer_version_key/);
    expect(sql.match(/CREATE UNIQUE INDEX[^;]*ON "scores"/g) ?? []).toHaveLength(1);
  });

  it('is not declared in schema.prisma, which cannot express it', () => {
    // If someone "helpfully" adds an @@unique back, Prisma will create a
    // NULLS DISTINCT index alongside this one and the bug returns.
    const schema = readFileSync(join(import.meta.dirname, '../prisma/schema.prisma'), 'utf8');
    const scoreModel = schema.slice(schema.indexOf('model Score {'));
    const body = scoreModel.slice(0, scoreModel.indexOf('\n}'));
    expect(body).not.toMatch(/@@unique/);
  });
});
