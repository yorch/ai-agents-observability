import type { AppDeps } from '../src/app.js';

export function makeTestDeps(): AppDeps {
  return {
    checkDb: async () => {},
    checkS3: async () => {},
    db: {
      authToken: { findFirst: async () => null } as any,
      repo: { upsert: async () => ({}) } as any,
      $executeRaw: async () => 0,
    } as any,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({} as any),
    } as any,
  };
}
