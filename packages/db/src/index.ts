import { PrismaClient } from './generated/client/index.js';

const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma._prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma._prisma = prisma;
}

export type * from './generated/client/index.js';
export { applySqlMigrations } from './sql-migrate.js';
export { PrismaClient };
