import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client/client.js';

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma._prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma._prisma = prisma;
}

export type * from './generated/client/client.js';
export { applySqlMigrations } from './sql-migrate.js';
export { PrismaClient };
