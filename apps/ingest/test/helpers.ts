import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import type { AppDeps } from '../src/app';

export function makeTestDeps(): AppDeps {
  const db = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    authToken: { findFirst: async () => null } as unknown as AppDeps['db']['authToken'],
    repo: {
      upsert: async () => ({ id: '00000000-0000-0000-0000-000000000099' }),
    } as unknown as AppDeps['db']['repo'],
    session: {
      findUnique: async () => null,
      update: async () => ({}),
    } as unknown as AppDeps['db']['session'],
  } as unknown as AppDeps['db'];
  // Interactive-transaction stub: run the callback with the same fake db.
  (db as { $transaction: unknown }).$transaction = async (fn: (tx: unknown) => unknown) => fn(db);

  return {
    checkDb: async () => {},
    checkS3: async () => {},
    db,
    logger: {
      child: () => ({}) as unknown as Logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    } as unknown as Logger,
    s3: {
      bucket: 'transcripts',
      client: { send: async () => ({}) } as unknown as S3Client,
    },
  };
}
