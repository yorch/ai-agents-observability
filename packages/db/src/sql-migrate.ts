import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from './generated/client/client.js';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const SQL_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'migrations');

const TRACKING_TABLE = '_db_sql_migrations';

export async function applySqlMigrations(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(SQL_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const rows = await prisma.$queryRawUnsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM ${TRACKING_TABLE} WHERE filename = $1`,
      file,
    );

    if (Number(rows[0]?.count ?? 0) > 0) {
      console.log(`[sql-migrate] already applied: ${file}`);
      continue;
    }

    const sql = readFileSync(join(SQL_MIGRATIONS_DIR, file), 'utf-8');
    const statements = parseSqlStatements(sql);

    await prisma.$transaction(async (tx: TxClient) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
      }
      await tx.$executeRawUnsafe(`INSERT INTO ${TRACKING_TABLE} (filename) VALUES ($1)`, file);
    });

    console.log(`[sql-migrate] applied: ${file}`);
  }
}

function parseSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => s.length > 0);
}
