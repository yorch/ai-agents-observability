import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import type { AppDeps } from '../src/app';
import type { Config } from '../src/config';

export function makeTestDeps(): AppDeps {
  const db = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    auditLog: {
      create: async () => ({}),
    } as unknown as AppDeps['db']['auditLog'],
    authToken: { findFirst: async () => null } as unknown as AppDeps['db']['authToken'],
    jiraIssue: {
      findMany: async () => [],
    } as unknown as AppDeps['db']['jiraIssue'],
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

/**
 * A complete `Config`. Every field the schema marks required is spelled out
 * here rather than in each test, so a new required setting breaks one place
 * instead of silently arriving as `undefined` in every app-level test.
 */
export function makeTestConfig(): Config {
  return {
    anthropic_base_url: 'https://api.anthropic.com',
    app_base_url: 'http://localhost:3000',
    billing_reconciliation_enabled: false,
    database_url: 'postgresql://test:test@localhost:5432/test',
    git_sha: 'abc1234',
    github_billing_scope_kind: 'organization',
    jira_project_keys: [],
    judge_high_cost_usd: 5,
    judge_max_sessions_per_run: 25,
    judge_model: 'claude-opus-5',
    judge_sample_rate: 0.1,
    log_level: 'error',
    node_env: 'test',
    org_max_retention_days: 730,
    port: 4000,
    s3_access_key_id: 'test',
    s3_bucket: 'test',
    s3_endpoint: 'http://localhost:9000',
    s3_force_path_style: true,
    s3_region: 'us-east-1',
    s3_secret_access_key: 'test',
    semantic_search_enabled: false,
    smtp_port: 587,
    smtp_secure: false,
    transcript_retention_days: 365,
  };
}
