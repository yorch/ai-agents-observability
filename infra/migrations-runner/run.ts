import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { applySqlMigrations, PrismaClient } from '@ai-agents-observability/db';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const url = new URL(DATABASE_URL);
const pgHost = url.hostname;
const pgPort = Number(url.port) || 5432;

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

await waitForPostgres(pgHost, pgPort);

// Ensure TimescaleDB extension before any migrations
const bootstrap = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
try {
  await bootstrap.$executeRaw`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE`;
  console.log('[runner] TimescaleDB extension ready');
} finally {
  await bootstrap.$disconnect();
}

// Run Prisma migrations
console.log('[runner] Running prisma migrate deploy...');
execSync('bunx prisma migrate deploy', {
  env: { ...process.env, DATABASE_URL },
  stdio: 'inherit',
});

// Apply raw SQL migrations (Timescale DDL not managed by Prisma)
console.log('[runner] Applying SQL migrations...');
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
try {
  await applySqlMigrations(prisma);
} finally {
  await prisma.$disconnect();
}

console.log('[runner] All migrations complete.');
