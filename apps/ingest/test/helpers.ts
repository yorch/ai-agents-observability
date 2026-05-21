import type { Logger } from 'pino';

import type { AppDeps } from '../src/app';

export function makeTestDeps(): AppDeps {
  return {
    checkDb: async () => {},
    checkS3: async () => {},
    db: {
      $executeRaw: async () => 0,
      authToken: { findFirst: async () => null } as unknown as AppDeps['db']['authToken'],
      repo: { upsert: async () => ({}) } as unknown as AppDeps['db']['repo'],
    } as unknown as AppDeps['db'],
    logger: {
      child: () => ({}) as unknown as Logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    } as unknown as Logger,
  };
}
