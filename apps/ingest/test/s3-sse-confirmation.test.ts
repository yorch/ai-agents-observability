import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registry } from '../src/lib/metrics';
import { putObject, resetSseWarningForTests } from '../src/lib/s3';

function setup(response: Record<string, unknown>) {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;
  const deps = {
    bucket: 'b',
    client: { send: vi.fn(async () => response) } as unknown as S3Client,
  };
  return { deps, logger, warn };
}

const put = (
  s: ReturnType<typeof setup>,
  sse?: Parameters<typeof putObject>[5],
  n = 1,
): Promise<unknown> =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      putObject(s.deps, `k${i}`, new Uint8Array([1]), 'x/y', undefined, sse, s.logger),
    ),
  );

async function counter(): Promise<number> {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === 'sse_unconfirmed_total');
  return (m?.values[0]?.value as number | undefined) ?? 0;
}

describe('SSE confirmation check', () => {
  beforeEach(() => resetSseWarningForTests());

  it('does not warn when SSE was not requested', async () => {
    const s = setup({});
    await put(s, undefined, 3);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('does not warn when the store echoes the requested algorithm', async () => {
    const s = setup({ ServerSideEncryption: 'AES256' });
    const before = await counter();
    await put(s, { algorithm: 'AES256' }, 3);
    expect(s.warn).not.toHaveBeenCalled();
    expect(await counter()).toBe(before);
  });

  it('warns exactly once across many puts when the store does not echo it', async () => {
    const s = setup({});
    const before = await counter();
    await put(s, { algorithm: 'AES256', endpointHost: 'object-store:9000' }, 5);
    expect(s.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = s.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      confirmed: null,
      endpointHost: 'object-store:9000',
      requested: 'AES256',
    });
    expect(msg).toContain('SECURITY.md');
    expect(await counter()).toBe(before + 5);
  });

  it('warns when the store echoes a different algorithm', async () => {
    const s = setup({ ServerSideEncryption: 'AES256' });
    await put(s, { algorithm: 'aws:kms', kmsKeyId: 'k' });
    expect(s.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = s.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ confirmed: 'AES256' });
    // A different echo means the object IS encrypted; the message must not say otherwise.
    expect(msg).toContain('encrypted, but not as configured');
    expect(msg).not.toContain('UNENCRYPTED');
  });

  it('aws:kms: confirmed algorithm passes even if the echoed key id is a full ARN', async () => {
    const s = setup({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
    });
    await put(s, { algorithm: 'aws:kms', kmsKeyId: 'alias/transcripts' }, 2);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('aws:kms: missing echo warns', async () => {
    const s = setup({});
    await put(s, { algorithm: 'aws:kms', kmsKeyId: 'k' });
    expect(s.warn).toHaveBeenCalledTimes(1);
  });

  it('never fails the upload', async () => {
    const s = setup({});
    await expect(put(s, { algorithm: 'AES256' })).resolves.toBeDefined();
  });
});
