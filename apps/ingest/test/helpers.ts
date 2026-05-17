import type { AppDeps } from '../src/app.js';

export function makeTestDeps(): AppDeps {
  return {
    checkDb: async () => {},
    checkS3: async () => {},
    db: {
      $executeRaw: async () => 0,
      authToken: { findFirst: async () => null } as any,
      repo: { upsert: async () => ({}) } as any,
    } as any,
    logger: {
      child: () => ({}) as any,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    } as any,
  };
}
