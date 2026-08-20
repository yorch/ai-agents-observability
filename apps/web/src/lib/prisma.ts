import { createClient, type PrismaClient, withInteractiveOnly } from '@ai-agents-observability/db';

import { requireEnv } from './env';

// Lazy singleton — only constructs the Prisma client on first use so route
// modules can import this file without DATABASE_URL set at build time
// (Next evaluates route modules during static analysis). Cached on globalThis
// in every environment — pinning to globalThis matters in production too,
// because Next can re-import server modules on a per-route basis under some
// deploy targets and we must reuse one pg pool to avoid `too many clients`.
//
// Two accessors over **one connection pool**. `$extends` wraps the same client
// rather than opening a second one, so the unguarded accessor below costs no
// extra connections.
// Distinct keys, and deliberately not `_prisma`. `packages/db` publishes a
// module-level singleton under `globalThis._prisma` outside production, so
// sharing that key meant importing the db package pre-populated this cache with
// an **unguarded** client — and `getPrisma()` handed it back, silently defeating
// the extension below. Harmless while both clients were the same object; a
// missing filter once one of them carries a guard.
const globalForPrisma = globalThis as unknown as {
  _prismaAllRuns?: PrismaClient;
  _prismaGuarded?: PrismaClient;
};

function base(): PrismaClient {
  if (!globalForPrisma._prismaAllRuns) {
    globalForPrisma._prismaAllRuns = createClient(requireEnv('DATABASE_URL'));
  }
  return globalForPrisma._prismaAllRuns;
}

/**
 * The client every dashboard read uses. Session reads are scoped to
 * `run_kind = 'INTERACTIVE'` by the extension (P13-012), so a query cannot
 * silently include CI or eval runs by forgetting a filter.
 */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma._prismaGuarded) {
    globalForPrisma._prismaGuarded = withInteractiveOnly(base());
  }
  return globalForPrisma._prismaGuarded;
}

/**
 * The unguarded client, for the reads that legitimately see every run.
 *
 * Three kinds qualify, and they are the same three the raw-SQL side exempts:
 * per-session drill-downs (a page scoped to one id is not a population, and
 * filtering it renders empty tabs instead of excluding anything), facet counts
 * over a person's *own* data, and inventory reads that are about the fleet
 * rather than about people.
 *
 * `reason` is required and unused at runtime, on purpose — the same device
 * `readScores`' `aggregate-only` access uses. It forces the exemption to be
 * argued for at the call site and makes it visible in a diff, so a reviewer sees
 * a claim rather than an absence.
 */
export function getAllRunsPrisma(reason: string): PrismaClient {
  void reason;
  return base();
}
