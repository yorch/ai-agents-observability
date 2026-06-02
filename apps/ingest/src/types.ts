import type { PrismaClient } from '@ai-agents-observability/db';

export type User = { expiresAt: Date | null; id: string; kind: 'hook' };

export type AppEnv = {
  Variables: {
    requestId: string;
    user?: User;
  };
};

export type EventsDb = Pick<PrismaClient, 'repo' | 'sessionPRLink' | 'pullRequest'> & {
  $executeRaw: PrismaClient['$executeRaw'];
  $queryRaw: PrismaClient['$queryRaw'];
  $transaction: PrismaClient['$transaction'];
};

export type SessionDb = Pick<PrismaClient, 'session'>;
