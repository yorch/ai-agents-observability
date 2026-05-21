import { createClient, type PrismaClient } from '@ai-agents-observability/db';

import { requireEnv } from './env';

// Lazy singleton — only constructs the Prisma client on first use so route
// modules can import this file without DATABASE_URL set at build time
// (Next evaluates route modules during static analysis). Cached on globalThis
// across Next dev HMR reloads to avoid pool exhaustion.
const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (globalForPrisma._prisma) {
    return globalForPrisma._prisma;
  }
  const client = createClient(requireEnv('DATABASE_URL'));
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma._prisma = client;
  }
  return client;
}
