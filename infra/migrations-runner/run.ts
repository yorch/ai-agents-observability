import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { applySqlMigrations, PrismaClient } from '@ai-agents-observability/db';
import { PrismaPg } from '@prisma/adapter-pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const url = new URL(DATABASE_URL);
const pgHost = url.hostname;
const pgPort = Number(url.port) || 5432;

// run.ts is placed at /app/run.ts in the container, so packages/db is a sibling dir
const DB_PACKAGE_DIR = join(import.meta.dirname, 'packages', 'db');

async function waitForPostgres(host: string, port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      console.log(`[runner] PostgreSQL ready at ${host}:${port}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms`);
}

function makeClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL as string });
  return new PrismaClient({ adapter });
}

await waitForPostgres(pgHost, pgPort);

// Ensure TimescaleDB extension before any migrations
const bootstrap = makeClient();
try {
  await bootstrap.$executeRaw`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE`;
  console.log('[runner] TimescaleDB extension ready');
} finally {
  await bootstrap.$disconnect();
}

// Run Prisma migrations — cwd must be packages/db so prisma.config.ts is found
console.log('[runner] Running prisma migrate deploy...');
execSync('bunx prisma migrate deploy', {
  cwd: DB_PACKAGE_DIR,
  env: { ...process.env, DATABASE_URL },
  stdio: 'inherit',
});

// Apply raw SQL migrations (Timescale DDL not managed by Prisma)
console.log('[runner] Applying SQL migrations...');
const prisma = makeClient();
try {
  await applySqlMigrations(prisma);
} finally {
  await prisma.$disconnect();
}

console.log('[runner] All migrations complete.');
