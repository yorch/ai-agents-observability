import { gzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { processTranscript, TranscriptTooLargeError } from '../src/lib/transcript-pipeline';
import { makeTestDeps } from './helpers';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = '01906a44-0000-7000-8000-000000000000';
const TOKEN = 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function authedDeps() {
  const deps = makeTestDeps();
  const authStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
  authStub.findFirst = vi.fn().mockResolvedValue({
    expiresAt: null,
    id: 'tok-1',
    kind: 'hook',
    revokedAt: null,
    userId: USER_ID,
  });
  return deps;
}

function compress(text: string): Uint8Array {
  return new Uint8Array(zstdCompressSync(new TextEncoder().encode(text)));
}

function gzipCompress(text: string): Uint8Array {
  return new Uint8Array(gzipSync(new TextEncoder().encode(text)));
}

describe('POST /v1/transcripts/:session_id', () => {
  it('returns 415 when Content-Type is not application/x-zstd or application/gzip', async () => {
    const deps = authedDeps();
    const app = createApp({} as unknown as Config, deps);

    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: 'irrelevant',
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(res.status).toBe(415);
  });

  it('returns 404 when the session does not exist', async () => {
    const deps = authedDeps();
    const sessionStub = deps.db.session as unknown as { findUnique: ReturnType<typeof vi.fn> };
    sessionStub.findUnique = vi.fn().mockResolvedValue(null);
    const app = createApp({} as unknown as Config, deps);

    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compress('{}\n'),
      headers: { Authorization: TOKEN, 'Content-Type': 'application/x-zstd' },
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the session belongs to a different user', async () => {
    const deps = authedDeps();
    const sessionStub = deps.db.session as unknown as { findUnique: ReturnType<typeof vi.fn> };
    sessionStub.findUnique = vi.fn().mockResolvedValue({
      sessionId: SESSION_ID,
      startedAt: new Date('2026-05-21T12:00:00Z'),
      transcriptBytes: null,
      transcriptS3Key: null,
      transcriptUploadedAt: null,
      userId: 'someone-else',
    });
    const app = createApp({} as unknown as Config, deps);

    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compress('{}\n'),
      headers: { Authorization: TOKEN, 'Content-Type': 'application/x-zstd' },
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('uploads a transcript, redacts secrets, and records metadata on the session', async () => {
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

    const sent: { Body?: Uint8Array; Bucket?: string; Key?: string }[] = [];
    deps.s3.client = {
      send: vi.fn(async (cmd: unknown) => {
        const input = (cmd as { input?: { Body?: Uint8Array; Bucket?: string; Key?: string } })
          .input;
        if (input?.Body) {
          sent.push(input);
        }
        return {};
      }),
    } as unknown as S3Client;

    const payload = [
      '{"role":"user","content":"hi"}',
      // GitHub PAT — should be redacted
      '{"role":"assistant","content":"token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      '',
    ].join('\n');
    const compressed = compress(payload);

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compressed,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/x-zstd' },
      method: 'POST',
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      bytes: number;
      object_key: string;
      redaction_flags: string[];
    };
    expect(body.object_key).toMatch(
      new RegExp(`transcripts/\\d{4}/\\d{2}/\\d{2}/${USER_ID}/${SESSION_ID}\\.jsonl\\.zst`),
    );
    expect(body.redaction_flags).toContain('github-token');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.Bucket).toBe('transcripts');
    expect(sessionStub.update).toHaveBeenCalledTimes(1);
  });

  it('accepts a gzip-compressed transcript and stores it as zstd', async () => {
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

    const sent: { Body?: Uint8Array; Bucket?: string; Key?: string }[] = [];
    deps.s3.client = {
      send: vi.fn(async (cmd: unknown) => {
        const input = (cmd as { input?: { Body?: Uint8Array; Bucket?: string; Key?: string } })
          .input;
        if (input?.Body) {
          sent.push(input);
        }
        return {};
      }),
    } as unknown as S3Client;

    const payload = [
      '{"role":"user","content":"hi"}',
      '{"role":"assistant","content":"hello"}',
      '',
    ].join('\n');
    const compressed = gzipCompress(payload);

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: compressed,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/gzip' },
      method: 'POST',
    });

    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    // S3 object must be zstd-compressed regardless of input format
    const stored = sent[0]?.Body as Uint8Array;
    const decompressed = new TextDecoder().decode(zstdDecompressSync(stored));
    expect(decompressed).toContain('"role":"user"');
    expect(sessionStub.update).toHaveBeenCalledTimes(1);
  });

  it('returns 202 with received offset for an intermediate chunk', async () => {
    const deps = authedDeps();
    const sessionStub = deps.db.session as unknown as { findUnique: ReturnType<typeof vi.fn> };
    sessionStub.findUnique = vi.fn().mockResolvedValue({
      sessionId: SESSION_ID,
      startedAt: new Date('2026-05-21T12:00:00Z'),
      transcriptBytes: null,
      transcriptS3Key: null,
      transcriptUploadedAt: null,
      userId: USER_ID,
    });

    const chunk = new Uint8Array(64);
    const app = createApp({} as unknown as Config, deps);
    const res = await app.request(`/v1/transcripts/${SESSION_ID}`, {
      body: chunk,
      headers: {
        Authorization: TOKEN,
        'Content-Range': 'bytes 0-63/200',
        'Content-Type': 'application/x-zstd',
      },
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { received: number; total: number };
    expect(body.received).toBe(64);
    expect(body.total).toBe(200);
  });
});

describe('processTranscript', () => {
  it('preserves line count and flags secrets per line (zstd input)', () => {
    const input = ['ok line', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tail', ''].join('\n');
    const compressed = compress(input);
    const result = processTranscript(compressed);
    expect(result.redactionFlags).toContain('github-token');

    const decoded = new TextDecoder().decode(zstdDecompressSync(result.recompressed));
    expect(decoded.split('\n')).toHaveLength(4);
    expect(decoded).toContain('ok line');
    expect(decoded).not.toContain('ghp_aaaa');
  });

  it('decompresses gzip input and recompresses output as zstd', () => {
    const input = ['ok line', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tail', ''].join('\n');
    const compressed = gzipCompress(input);
    const result = processTranscript(compressed, 'application/gzip');
    expect(result.redactionFlags).toContain('github-token');

    // Output must always be zstd regardless of input format
    const decoded = new TextDecoder().decode(zstdDecompressSync(result.recompressed));
    expect(decoded.split('\n')).toHaveLength(4);
    expect(decoded).toContain('ok line');
    expect(decoded).not.toContain('ghp_aaaa');
  });

  it('throws TranscriptTooLargeError when decompressed size exceeds the cap', () => {
    // A highly-compressible payload (10k repeated chars) that decompresses well
    // past a tiny injected cap — simulates a decompression bomb without 512 MB.
    const bomb = compress('A'.repeat(10_000));
    expect(() => processTranscript(bomb, undefined, 64)).toThrow(TranscriptTooLargeError);
  });
});
