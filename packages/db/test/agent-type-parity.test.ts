import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_TYPES } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';

import { AgentType } from '../src/index';

// P12-001. `agent_type` flows hook → ingest → DB, so three definitions must agree:
// the wire enum (packages/schemas), the Prisma enum, and the SQL that actually
// creates the Postgres type. Prisma's idempotency check is name-based — editing an
// already-applied migration is silently ignored (see AGENTS.md, "the drift trap") —
// so the migration SQL is checked as text rather than trusted to match the schema.

const MIGRATION_SQL = join(
  import.meta.dirname,
  '../prisma/migrations/20260814000000_init/migration.sql',
);

function enumValuesFromInitMigration(): string[] {
  const sql = readFileSync(MIGRATION_SQL, 'utf8');
  const match = /CREATE TYPE "AgentType" AS ENUM \(([^)]*)\);/.exec(sql);
  if (!match?.[1]) {
    throw new Error('CREATE TYPE "AgentType" not found in the init migration');
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('AgentType parity', () => {
  it('matches between the wire enum and the Prisma enum', () => {
    expect(new Set(Object.keys(AgentType))).toEqual(new Set(AGENT_TYPES));
  });

  it('matches between the Prisma enum and the applied init migration', () => {
    expect(new Set(enumValuesFromInitMigration())).toEqual(new Set(Object.keys(AgentType)));
  });

  it('never reorders existing migration values (Postgres enum order is on-disk)', () => {
    // Appending is safe; reordering rewrites the type. The first seven values are
    // the P5-006 set and must stay in this order.
    expect(enumValuesFromInitMigration().slice(0, 7)).toEqual([
      'CLAUDE_CODE',
      'CURSOR',
      'AIDER',
      'COPILOT',
      'CODEX',
      'WINDSURF',
      'OPENCODE',
    ]);
  });
});
