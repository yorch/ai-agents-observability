import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AuditAction } from '../src/index';

/**
 * `sql/migrations/0004_audit_action_catchup.sql` repairs databases that applied
 * the squashed init migration before an `AuditAction` value was added to it.
 * It can only do that if it lists every value.
 *
 * The failure this guards is the one that created the need for the file, and it
 * is silent in both directions: `writeAuditLog` never throws, so writing a value
 * Postgres does not know logs a warning nobody reads and drops the audit row. A
 * value added to `schema.prisma` and the init migration but NOT here would ship
 * exactly that behaviour again, to exactly the same people — everyone upgrading
 * rather than installing fresh.
 *
 * Text, not a live database, for the same reason `agent-type-parity.test.ts`
 * reads text: this must fail in CI, which has no Postgres for the default suite.
 */

const CATCHUP_SQL = join(import.meta.dirname, '../sql/migrations/0004_audit_action_catchup.sql');

function valuesInCatchup(): string[] {
  const sql = readFileSync(CATCHUP_SQL, 'utf8');
  // Only ALTER statements — the file's comment block names several values in
  // prose, and matching those would let a value "pass" by being mentioned.
  return [...sql.matchAll(/ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS '([^']+)';/g)].map(
    (m) => m[1] as string,
  );
}

describe('AuditAction catch-up migration', () => {
  it('lists every value in the Prisma enum', () => {
    expect(new Set(valuesInCatchup())).toEqual(new Set(Object.keys(AuditAction)));
  });

  it('lists them in schema order, so a missing value appends where init puts it', () => {
    // Postgres enum order is on-disk. A value appended here lands last, which is
    // where the init migration puts it on a fresh database — so a repaired
    // database and a fresh one agree. Emitting them out of order would not error,
    // but the two would diverge.
    expect(valuesInCatchup()).toEqual(Object.keys(AuditAction));
  });

  it('guards every statement with IF NOT EXISTS', () => {
    // Not a style nit — without it this file breaks every FRESH install.
    //
    // `applySqlMigrations()` records applied filenames in `_db_sql_migrations`
    // and skips them afterwards, so this runs once per database, not on every
    // deployment. The once it runs is the problem: on a fresh database layer 1
    // has already created `AuditAction` complete, so every value here already
    // exists. A bare `ADD VALUE` then fails on its first and only application —
    // `ERROR: enum label "..." already exists`, verified against PG18 — which
    // aborts the transaction the runner wraps the file in, exits
    // `migrations-runner` non-zero, and leaves every service gated on
    // `condition: service_completed_successfully` refusing to start.
    //
    // So the common path (a new install) is the one that breaks, not the rare
    // one. `IF NOT EXISTS` is also what makes the file safe to re-run after a
    // crash mid-transaction, which is the belt-and-braces reason AGENTS.md
    // gives for every file in this layer.
    const sql = readFileSync(CATCHUP_SQL, 'utf8');
    const alters = [...sql.matchAll(/^ALTER TYPE .*$/gm)].map((m) => m[0]);
    expect(alters.length).toBeGreaterThan(0);
    expect(alters.filter((s) => !s.includes('IF NOT EXISTS'))).toEqual([]);
  });
});
