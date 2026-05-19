import type { PrismaClient } from '@ai-agents-observability/db';

export type User = { expiresAt: Date | null; id: string; kind: 'hook' };

export type AppEnv = {
  Variables: {
    requestId: string;
    user?: User;
  };
};

export type EventsDb = Pick<PrismaClient, 'repo'> & {
  $executeRaw: PrismaClient['$executeRaw'];
};
