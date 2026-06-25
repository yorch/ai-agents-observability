import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { applySqlMigrations, createClient } from './index';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const DB_PACKAGE_DIR = join(import.meta.dirname, '..');

// 1. TimescaleDB extension
const bootstrap = createClient(DATABASE_URL);
try {
  await bootstrap.$executeRaw`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE`;
  console.log('[deploy] TimescaleDB extension ready');
} finally {
  await bootstrap.$disconnect();
}

// 2. Prisma relational schema
console.log('[deploy] Running prisma migrate deploy...');
const result = spawnSync('bunx', ['prisma', 'migrate', 'deploy'], {
  cwd: DB_PACKAGE_DIR,
  env: { ...process.env, DATABASE_URL },
  stdio: 'inherit',
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// 3. TimescaleDB DDL + data seeds
console.log('[deploy] Applying SQL migrations...');
const prisma = createClient(DATABASE_URL);
try {
  await applySqlMigrations(prisma);
} finally {
  await prisma.$disconnect();
}

console.log('[deploy] Done.');
