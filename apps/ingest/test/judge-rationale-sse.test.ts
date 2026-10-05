import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type JudgeRationaleArtifact, putJudgeRationale } from '../src/lib/judge-rationales';
import { registry } from '../src/lib/metrics';
import { resetSseWarningForTests, sseRequestFromConfig } from '../src/lib/s3';

const artifact: JudgeRationaleArtifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  judgeModel: 'm',
  judgePromptVersion: 1,
  planCoherence: { label: 'GOOD', rationale: 'fine' },
  scorerVersion: 2,
  sessionId: 'sess-1',
  taskCompletion: { label: 'GOOD', rationale: 'key AKIAIOSFODNN7EXAMPLE leaked' },
};

function setup(response: Record<string, unknown> = {}) {
  const send = vi.fn(async (_cmd: { input: Record<string, unknown> }) => response);
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, s3: { send } as unknown as S3Client, send, warn };
}

async function counter(): Promise<number> {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === 'sse_unconfirmed_total');
  return (m?.values[0]?.value as number | undefined) ?? 0;
}

describe('putJudgeRationale server-side encryption', () => {
  beforeEach(() => resetSseWarningForTests());

  it('sends no SSE fields when SSE is not configured', async () => {
    const t = setup();
    await putJudgeRationale(t.s3, 'b', artifact, undefined, t.logger);
    const input = t.send.mock.calls[0]?.[0].input ?? {};
    expect(input).not.toHaveProperty('ServerSideEncryption');
    expect(input).not.toHaveProperty('SSEKMSKeyId');
    expect(t.warn).not.toHaveBeenCalled();
  });

  it('sends AES256 and keeps key, content type and redaction', async () => {
    const t = setup({ ServerSideEncryption: 'AES256' });
    const { key } = await putJudgeRationale(t.s3, 'b', artifact, { algorithm: 'AES256' }, t.logger);
    const input = t.send.mock.calls[0]?.[0].input ?? {};
    expect(input).toMatchObject({
      Bucket: 'b',
      ContentType: 'application/json',
      Key: 'judge-rationales/sess-1/v2.json',
      ServerSideEncryption: 'AES256',
    });
    expect(key).toBe('judge-rationales/sess-1/v2.json');
    expect(input).not.toHaveProperty('SSEKMSKeyId');
    expect(new TextDecoder().decode(input.Body as Uint8Array)).not.toContain(
      'AKIAIOSFODNN7EXAMPLE',
    );
    expect(t.warn).not.toHaveBeenCalled();
  });

  it('sends SSEKMSKeyId for aws:kms', async () => {
    const t = setup({ ServerSideEncryption: 'aws:kms' });
    await putJudgeRationale(
      t.s3,
      'b',
      artifact,
      { algorithm: 'aws:kms', kmsKeyId: 'kid' },
      t.logger,
    );
    expect(t.send.mock.calls[0]?.[0].input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kid',
    });
  });

  it('counts and warns once when the store does not confirm SSE', async () => {
    const t = setup({});
    const before = await counter();
    const sse = { algorithm: 'AES256' as const, endpointHost: 'garage:3900' };
    await putJudgeRationale(t.s3, 'b', artifact, sse, t.logger);
    await putJudgeRationale(t.s3, 'b', artifact, sse, t.logger);
    expect(await counter()).toBe(before + 2);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });
});

describe('sseRequestFromConfig', () => {
  const base = { s3_endpoint: 'http://AKIAEXAMPLE:s3cr3t@store.internal:9000/path' };

  it('is undefined when no algorithm is configured, even with a KMS key id', () => {
    expect(sseRequestFromConfig({ ...base, s3_kms_key_id: 'k' })).toBeUndefined();
  });

  it('keeps only the credential-free host of the endpoint', () => {
    expect(sseRequestFromConfig({ ...base, s3_sse_algorithm: 'AES256' })).toEqual({
      algorithm: 'AES256',
      endpointHost: 'store.internal:9000',
    });
  });

  it('sends the KMS key id only for aws:kms algorithms (config.ts: "Ignored otherwise")', () => {
    expect(
      sseRequestFromConfig({ ...base, s3_kms_key_id: 'k', s3_sse_algorithm: 'AES256' }),
    ).not.toHaveProperty('kmsKeyId');
    expect(
      sseRequestFromConfig({ ...base, s3_kms_key_id: 'k', s3_sse_algorithm: 'aws:kms' }),
    ).toMatchObject({ kmsKeyId: 'k' });
    expect(
      sseRequestFromConfig({ ...base, s3_kms_key_id: 'k', s3_sse_algorithm: 'aws:kms:dsse' }),
    ).toMatchObject({ kmsKeyId: 'k' });
  });

  it('carries algorithm, endpoint host and kms key', () => {
    expect(
      sseRequestFromConfig({
        s3_endpoint: 'http://garage:3900',
        s3_kms_key_id: 'k',
        s3_sse_algorithm: 'aws:kms',
      }),
    ).toEqual({ algorithm: 'aws:kms', endpointHost: 'garage:3900', kmsKeyId: 'k' });
  });
});
