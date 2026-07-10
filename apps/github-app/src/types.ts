import type { PrismaClient } from '@ai-agents-observability/db';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export type AppDb = Pick<
  PrismaClient,
  | '$transaction'
  | 'pRCheckRun'
  | 'pRReview'
  | 'pullRequest'
  | 'pRRollup'
  | 'repo'
  | 'session'
  | 'sessionCommitLink'
  | 'sessionPRLink'
  | 'user'
  | 'webhookDelivery'
>;
