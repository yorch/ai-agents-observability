import { createClient, type PrismaClient } from '@ai-agents-observability/db';

import { requireEnv } from './env';

// Lazy singleton — only constructs the Prisma client on first use so route
// modules can import this file without DATABASE_URL set at build time
// (Next evaluates route modules during static analysis). Cached on globalThis
// in every environment — pinning to globalThis matters in production too,
// because Next can re-import server modules on a per-route basis under some
// deploy targets and we must reuse one pg pool to avoid `too many clients`.
const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (globalForPrisma._prisma) {
    return globalForPrisma._prisma;
  }
  globalForPrisma._prisma = createClient(requireEnv('DATABASE_URL'));
  return globalForPrisma._prisma;
}
