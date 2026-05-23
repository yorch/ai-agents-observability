import type { PrismaClient } from '@ai-agents-observability/db';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export type AppDb = Pick<
  PrismaClient,
  'pullRequest' | 'repo' | 'session' | 'sessionPRLink' | 'pRRollup' | 'webhookDelivery' | 'user'
>;
