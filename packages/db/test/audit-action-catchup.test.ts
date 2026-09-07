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
    // The file runs unconditionally on every deployment, inside the single
    // transaction `applySqlMigrations()` wraps it in. A bare ADD VALUE throws on
    // the second run; `migrations-runner` then exits non-zero and every service
    // gated on it refuses to start. So a plain ADD VALUE here is a boot failure,
    // not a style nit.
    const sql = readFileSync(CATCHUP_SQL, 'utf8');
    const alters = [...sql.matchAll(/^ALTER TYPE .*$/gm)].map((m) => m[0]);
    expect(alters.length).toBeGreaterThan(0);
    expect(alters.filter((s) => !s.includes('IF NOT EXISTS'))).toEqual([]);
  });
});
