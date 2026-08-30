import { zstdCompressSync } from 'node:zlib';

import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { makeTestConfig, makeTestDeps } from './helpers';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = '01906a44-0000-7000-8000-000000000000';
const TOKEN = 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function authedDeps() {
  const deps = makeTestDeps();
  const authStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
  authStub.findFirst = vi.fn().mockResolvedValue({
    expiresAt: null,
    id: 'tok-1',
    kind: 'HOOK',
    revokedAt: null,
    userId: USER_ID,
  });
  return deps;
}

function compress(text: string): Uint8Array {
  return new Uint8Array(zstdCompressSync(new TextEncoder().encode(text)));
}

function sessionDeps() {
  const deps = authedDeps();
  const sessionStub = deps.db.session as unknown as {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  sessionStub.findUnique = vi.fn().mockResolvedValue({
    sessionId: SESSION_ID,
    startedAt: new Date('2026-05-21T12:00:00Z'),
    transcriptBytes: null,
    transcriptS3Key: null,
    transcriptUploadedAt: null,
    userId: USER_ID,
  });
  sessionStub.update = vi.fn().mockResolvedValue({});
  return deps;
}

function captureS3Send(deps: ReturnType<typeof makeTestDeps>) {
  const sent: {
    ServerSideEncryption?: string;
    SSEKMSKeyId?: string;
  }[] = [];
  deps.s3.client = {
    send: vi.fn(async (cmd: unknown) => {
      const input = (
        cmd as {
          input?: { Body?: Uint8Array; ServerSideEncryption?: string; SSEKMSKeyId?: string };
        }
      ).input;
      if (input?.Body) {
        const entry: { ServerSideEncryption?: string; SSEKMSKeyId?: string } = {};
        if (input.ServerSideEncryption !== undefined) {
          entry.ServerSideEncryption = input.ServerSideEncryption;
        }
        if (input.SSEKMSKeyId !== undefined) {
          entry.SSEKMSKeyId = input.SSEKMSKeyId;
        }
        sent.push(entry);
      }
      return {};
    }),
  } as unknown as S3Client;
  return sent;
}

describe('S3 server-side encryption', () => {
  it('passes SSE headers when S3_SSE_ALGORITHM is set', async () => {
    const deps = sessionDeps();
    const sent = captureS3Send(deps);

    const config = makeTestConfig();
    config.s3_sse_algorithm = 'AES256';

    const app = createApp(config, deps);
    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compress('{"role":"user","content":"hi"}\n'),
      headers: { Authorization: TOKEN, 'Content-Type': 'application/x-zstd' },
      method: 'POST',
    });

    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ServerSideEncryption).toBe('AES256');
    expect(sent[0]?.SSEKMSKeyId).toBeUndefined();
  });

  it('passes SSE-KMS key ID when both algorithm and key are set', async () => {
    const deps = sessionDeps();
    const sent = captureS3Send(deps);

    const config = makeTestConfig();
    config.s3_sse_algorithm = 'aws:kms';
    config.s3_kms_key_id = 'arn:aws:kms:us-east-1:123456789012:key/abc-def';

    const app = createApp(config, deps);
    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compress('{"role":"user","content":"hi"}\n'),
      headers: { Authorization: TOKEN, 'Content-Type': 'application/x-zstd' },
      method: 'POST',
    });

    expect(res.status).toBe(201);
    expect(sent[0]?.ServerSideEncryption).toBe('aws:kms');
    expect(sent[0]?.SSEKMSKeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/abc-def');
  });

  it('does not pass SSE headers when S3_SSE_ALGORITHM is unset', async () => {
    const deps = sessionDeps();
    const sent = captureS3Send(deps);

    const app = createApp(makeTestConfig(), deps);
    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compress('{"role":"user","content":"hi"}\n'),
      headers: { Authorization: TOKEN, 'Content-Type': 'application/x-zstd' },
      method: 'POST',
    });

    expect(res.status).toBe(201);
    expect(sent[0]?.ServerSideEncryption).toBeUndefined();
    expect(sent[0]?.SSEKMSKeyId).toBeUndefined();
  });
});
