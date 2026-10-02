import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { openQueue } from './lib/queue';
import * as queueReader from './lib/queue-reader';
import type { ShipMarker } from './shipper';
import { buildZstdBody, runShipper, uploadWithResume, writeShipMarker } from './shipper';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a sample JSONL transcript file with the given lines. */
function writeTranscript(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

type ReceivedUpload = {
  sessionId: string;
  contentEncoding: string | null;
  contentType: string | null;
  contentHash: string | null;
  bodyBytes: Uint8Array;
};

function startMockIngestServer(statusCode = 200): {
  port: number;
  received: ReceivedUpload[];
  server: ReturnType<typeof Bun.serve>;
} {
  const received: ReceivedUpload[] = [];

  const server = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/v1\/transcripts\/(.+)$/);
      if (req.method === 'POST' && match) {
        const sessionId = match[1] ?? '';
        const body = new Uint8Array(await req.arrayBuffer());
        received.push({
          bodyBytes: body,
          contentEncoding: req.headers.get('content-encoding'),
          contentHash: req.headers.get('x-content-hash'),
          contentType: req.headers.get('content-type'),
          sessionId,
        });
        return new Response(JSON.stringify({ ok: true }), { status: statusCode });
      }
      return new Response('not found', { status: 404 });
    },
    port: 0,
  });

  return { port: server.port ?? 0, received, server };
}

/** Decompress a zstd buffer into a string. */
async function zstdDecompress(data: Uint8Array): Promise<string> {
  return new TextDecoder().decode(zstdDecompressSync(data));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpHome: string;
let tmpTranscriptDir: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-shipper-test-'));
  tmpTranscriptDir = mkdtempSync(join(tmpdir(), 'aiot-transcripts-'));
  process.env.AIOT_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  rmSync(tmpTranscriptDir, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.INGEST_BASE_URL;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeShipMarker', () => {
  it('preserves the attempt count and first-seen time across re-writes', () => {
    // Claude Code's Stop fires once per response cycle, so an active session
    // re-writes its marker constantly. A fresh marker each time reset `attempts`
    // to 0 and `first_seen_at` to now — and both give-up conditions
    // (MAX_SHIP_ATTEMPTS, MAX_TRANSIENT_AGE_MS) are measured from exactly those
    // fields. So neither could ever be reached while a session was still doing
    // work: a transcript the server permanently rejects was re-read,
    // re-redacted, re-compressed and re-uploaded every sweep, for the life of
    // the session.
    const sessionId = 'test-session-merge';
    const transcriptPath = join(tmpTranscriptDir, 'transcript.jsonl');
    const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);

    writeShipMarker(sessionId, transcriptPath, false);
    const firstSeen = (JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker).first_seen_at;

    // Simulate the shipper having burned part of the retry budget.
    const withAttempts = {
      ...(JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker),
      attempts: 4,
    };
    writeFileSync(markerPath, JSON.stringify(withAttempts), 'utf8');

    // The next Stop re-writes the marker.
    writeShipMarker(sessionId, transcriptPath, false);

    const after = JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker;
    expect(after.attempts).toBe(4);
    expect(after.first_seen_at).toBe(firstSeen);
  });

  it('resets bytes_uploaded, because the transcript has grown', () => {
    // The opposite of the above, and deliberate: a resume offset from the
    // previous upload no longer describes a file that has since been appended to.
    const sessionId = 'test-session-bytes';
    const transcriptPath = join(tmpTranscriptDir, 'transcript.jsonl');
    const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);

    writeShipMarker(sessionId, transcriptPath, false);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker;
    writeFileSync(markerPath, JSON.stringify({ ...marker, bytes_uploaded: 9999 }), 'utf8');

    writeShipMarker(sessionId, transcriptPath, false);
    expect((JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker).bytes_uploaded).toBe(0);
  });

  it('leaves no temp file behind', () => {
    // The write is tmp + rename now; a stray `.tmp` would be read as a marker
    // by nothing, but it would accumulate one file per Stop.
    const sessionId = 'test-session-tmp';
    writeShipMarker(sessionId, join(tmpTranscriptDir, 'transcript.jsonl'), false);
    expect(existsSync(join(tmpHome, 'ship-queue', `${sessionId}.json.tmp`))).toBe(false);
  });

  it('creates a marker file in the ship-queue directory', () => {
    const sessionId = 'test-session-abc123';
    const transcriptPath = join(tmpTranscriptDir, 'transcript.jsonl');

    writeShipMarker(sessionId, transcriptPath, false);

    const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);
    expect(existsSync(markerPath)).toBe(true);

    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker;
    expect(marker.session_id).toBe(sessionId);
    expect(marker.transcript_path).toBe(transcriptPath);
    expect(marker.partial).toBe(false);
    expect(marker.bytes_uploaded).toBe(0);
  });

  it('creates the ship-queue directory if it does not exist', () => {
    const sessionId = 'session-xyz987';
    writeShipMarker(sessionId, '/tmp/fake.jsonl', true);
    expect(existsSync(join(tmpHome, 'ship-queue'))).toBe(true);
  });
});

describe('shipper upload', () => {
  it('uploads transcript, deletes marker, sends zstd body with correct headers', async () => {
    const sessionId = 'session-upload-test';
    const transcriptPath = join(tmpTranscriptDir, 'transcript.jsonl');

    // 10 lines, one with a fake AWS access key that should be redacted
    const lines = [
      JSON.stringify({ content: 'Hello world', role: 'user' }),
      JSON.stringify({ content: 'Hello! How can I help?', role: 'assistant' }),
      JSON.stringify({ content: 'My key is AKIAIOSFODNN7EXAMPLE please keep it', role: 'user' }),
      JSON.stringify({ content: 'I see you mentioned a key.', role: 'assistant' }),
      JSON.stringify({ content: 'Can you list files?', role: 'user' }),
      JSON.stringify({ content: 'Sure, running ls.', role: 'assistant' }),
      JSON.stringify({ content: 'What is 2+2?', role: 'user' }),
      JSON.stringify({ content: '4', role: 'assistant' }),
      JSON.stringify({ content: 'Thanks!', role: 'user' }),
      JSON.stringify({ content: 'Goodbye!', role: 'assistant' }),
    ];
    writeTranscript(transcriptPath, lines);

    // Write marker
    writeShipMarker(sessionId, transcriptPath, false);

    // Write identity token
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-jwt-token' }), {
      encoding: 'utf8',
    });

    const { port, received, server } = startMockIngestServer(200);
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      // Simulate what the shipper does: build zstd body and PUT to endpoint
      const { redactedLines } = await import('../src/lib/transcript-stream');

      const redactedLinesList: string[] = [];
      for await (const line of redactedLines(transcriptPath)) {
        redactedLinesList.push(line);
      }
      const text = redactedLinesList.join('\n');
      const encoded = new TextEncoder().encode(text);
      const hash = createHash('sha256').update(encoded).digest('hex');
      const body = new Uint8Array(zstdCompressSync(encoded));

      const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);
      expect(existsSync(markerPath)).toBe(true);

      const url = `http://localhost:${port}/v1/transcripts/${sessionId}`;
      const res = await fetch(url, {
        body,
        headers: {
          Authorization: 'Bearer test-jwt-token',
          'Content-Type': 'application/x-zstd',
          'X-Content-Hash': hash,
        },
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(received.length).toBe(1);

      const upload = received[0];
      expect(upload?.sessionId).toBe(sessionId);
      expect(upload?.contentEncoding).toBeNull();
      expect(upload?.contentType).toBe('application/x-zstd');
      expect(upload?.contentHash).toBe(hash);

      // Decompress and verify AWS key was redacted
      const decompressed = await zstdDecompress(upload?.bodyBytes ?? new Uint8Array());
      expect(decompressed).not.toContain('AKIAIOSFODNN7EXAMPLE');
      // Should contain redacted placeholder instead
      expect(decompressed).toContain('[REDACTED');
    } finally {
      server.stop(true);
    }
  });

  it('buildZstdBody streams to a zstd body whose hash matches the redacted join', async () => {
    const transcriptPath = join(tmpTranscriptDir, 'stream.jsonl');
    const lines = [
      JSON.stringify({ content: 'first line with émoji 🚀', role: 'user' }),
      JSON.stringify({ content: 'second AKIAIOSFODNN7EXAMPLE line', role: 'assistant' }),
      JSON.stringify({ content: 'third line', role: 'user' }),
    ];
    writeTranscript(transcriptPath, lines);

    const { body, hash } = await buildZstdBody(transcriptPath);

    // Body is valid zstd and decompresses to the redacted, newline-joined lines.
    const decompressed = await zstdDecompress(body);
    expect(decompressed).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(decompressed).toContain('[REDACTED');
    expect(decompressed.split('\n')).toHaveLength(3);

    // Hash is the sha256 of the uncompressed bytes (the idempotency key), so it
    // must equal hashing the decompressed payload.
    const expectedHash = createHash('sha256').update(decompressed, 'utf8').digest('hex');
    expect(hash).toBe(expectedHash);
  });

  it('does not contain the raw AWS access key after redaction', async () => {
    const transcriptPath = join(tmpTranscriptDir, 'sensitive.jsonl');
    writeTranscript(transcriptPath, [
      JSON.stringify({ content: 'My AWS key: AKIAIOSFODNN7EXAMPLE' }),
      JSON.stringify({ content: 'Normal message' }),
    ]);

    const { redactedLines } = await import('../src/lib/transcript-stream');
    const allLines: string[] = [];
    for await (const line of redactedLines(transcriptPath)) {
      allLines.push(line);
    }

    const combined = allLines.join('\n');
    expect(combined).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

// ── uploadWithResume tests ────────────────────────────────────────────────────

/** A mock ingest server that assembles Content-Range chunks in memory. */
function startChunkedMockServer(
  opts: {
    finalStatus?: number;
    initialScratch?: Uint8Array;
    intermediateStatus?: number;
    scratchCleared?: boolean;
  } = {},
): {
  port: number;
  received: Array<{ contentRange: string | null; bodySize: number }>;
  server: ReturnType<typeof Bun.serve>;
  scratchBytes: Uint8Array | null;
  clearScratch: () => void;
  setScratch: (bytes: Uint8Array) => void;
} {
  const received: Array<{ contentRange: string | null; bodySize: number }> = [];
  let scratchBytes: Uint8Array | null = opts.initialScratch ?? null;
  const finalStatus = opts.finalStatus ?? 200;
  const intermediateStatus = opts.intermediateStatus ?? 202;

  const server = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/v1\/transcripts\/(.+)$/);
      if (req.method === 'POST' && match) {
        const contentRange = req.headers.get('content-range');
        const body = new Uint8Array(await req.arrayBuffer());
        received.push({ bodySize: body.byteLength, contentRange });

        if (contentRange) {
          const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
          if (!m) {
            return new Response('bad range', { status: 400 });
          }
          const [, startStr, endStr, totalStr] = m as unknown as [string, string, string, string];
          const start = Number.parseInt(startStr, 10);
          const end = Number.parseInt(endStr, 10);
          const total = Number.parseInt(totalStr, 10);

          if (start === 0) {
            scratchBytes = body;
          } else {
            if (!scratchBytes || scratchBytes.byteLength !== start) {
              return new Response('Missing prior chunks', { status: 409 });
            }
            const merged = new Uint8Array(scratchBytes.byteLength + body.byteLength);
            merged.set(scratchBytes, 0);
            merged.set(body, scratchBytes.byteLength);
            scratchBytes = merged;
          }

          if (end + 1 < total) {
            return new Response(JSON.stringify({ received: end + 1, total }), {
              status: intermediateStatus,
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: finalStatus });
        }
        // No Content-Range — single upload
        return new Response(JSON.stringify({ ok: true }), { status: finalStatus });
      }
      return new Response('not found', { status: 404 });
    },
    port: 0,
  });

  return {
    clearScratch: () => {
      scratchBytes = null;
    },
    get port() {
      return server.port ?? 0;
    },
    get received() {
      return received;
    },
    get scratchBytes() {
      return scratchBytes;
    },
    server,
    setScratch: (bytes: Uint8Array) => {
      scratchBytes = bytes;
    },
  };
}

function makeMarker(sessionId: string, overrides: Partial<ShipMarker> = {}): ShipMarker {
  return {
    bytes_uploaded: 0,
    partial: false,
    session_id: sessionId,
    transcript_path: '/tmp/fake.jsonl',
    ...overrides,
  };
}

/** Compute a sha256 hex hash of a Uint8Array, for body_hash in tests. */
function sha256Hex(body: Uint8Array): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(body).digest('hex');
}

describe('uploadWithResume', () => {
  it('uploads a small body in a single chunk and returns 200', async () => {
    const { port, received, server } = startChunkedMockServer();
    try {
      const body = new Uint8Array(100);
      crypto.getRandomValues(body);
      const marker = makeMarker('session-single');
      const res = await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/session-single`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        sha256Hex(body),
      );
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.contentRange).toBe(`bytes 0-99/100`);
    } finally {
      server.stop(true);
    }
  });

  it('uploads a large body in multiple chunks with Content-Range', async () => {
    // Use a body larger than UPLOAD_CHUNK_SIZE (1 MB) to force multiple chunks.
    // We can't control the chunk size from the test, but we can use a 2.5 MB body.
    const { port, received, server } = startChunkedMockServer();
    try {
      const body = new Uint8Array(2.5 * 1024 * 1024);
      crypto.getRandomValues(body);
      const marker = makeMarker('session-multi');
      const res = await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/session-multi`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        sha256Hex(body),
      );
      expect(res.status).toBe(200);
      // 2.5 MB / 1 MB = 3 chunks (1 MB, 1 MB, 0.5 MB)
      expect(received.length).toBe(3);
      expect(received[0]?.contentRange).toBe(`bytes 0-${1024 * 1024 - 1}/${body.byteLength}`);
      expect(received[2]?.contentRange).toBe(
        `bytes ${2 * 1024 * 1024}-${body.byteLength - 1}/${body.byteLength}`,
      );
    } finally {
      server.stop(true);
    }
  });

  it('resumes from bytes_uploaded when body_size and body_hash match', async () => {
    const { port, received, server, setScratch } = startChunkedMockServer();
    try {
      const body = new Uint8Array(2.5 * 1024 * 1024);
      crypto.getRandomValues(body);
      const bodyHash = sha256Hex(body);
      // Marker says we already uploaded 1 MB of a 2.5 MB body
      const marker = makeMarker('session-resume', {
        body_hash: bodyHash,
        body_size: body.byteLength,
        bytes_uploaded: 1024 * 1024,
      });
      // Pre-populate the server's scratch file with the first 1 MB, simulating
      // a prior partial upload that the server still has on disk.
      setScratch(body.slice(0, 1024 * 1024));
      const res = await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/session-resume`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        bodyHash,
      );
      expect(res.status).toBe(200);
      // Should start from 1 MB, not 0 — only 2 chunks (1 MB, 0.5 MB)
      expect(received.length).toBe(2);
      expect(received[0]?.contentRange).toBe(
        `bytes ${1024 * 1024}-${2 * 1024 * 1024 - 1}/${body.byteLength}`,
      );
    } finally {
      server.stop(true);
    }
  });

  it('resets to 0 when body_size does not match', async () => {
    const { port, received, server } = startChunkedMockServer();
    try {
      const body = new Uint8Array(2.5 * 1024 * 1024);
      crypto.getRandomValues(body);
      // Marker says body_size was different (the transcript grew)
      const marker = makeMarker('session-reset', {
        body_size: 999_999, // different from body.byteLength
        bytes_uploaded: 1024 * 1024,
      });
      const res = await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/session-reset`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        sha256Hex(body),
      );
      expect(res.status).toBe(200);
      // Should start from 0 — all 3 chunks
      expect(received.length).toBe(3);
      expect(received[0]?.contentRange).toBe(`bytes 0-${1024 * 1024 - 1}/${body.byteLength}`);
    } finally {
      server.stop(true);
    }
  });

  it('resets to 0 when body_hash does not match (same size, different content)', async () => {
    const { port, received, server } = startChunkedMockServer();
    try {
      const body = new Uint8Array(2.5 * 1024 * 1024);
      crypto.getRandomValues(body);
      // Marker has the right body_size but a stale body_hash — the transcript
      // changed but compressed to the same size.
      const marker = makeMarker('session-hash-mismatch', {
        body_hash: '0'.repeat(64), // wrong hash
        body_size: body.byteLength,
        bytes_uploaded: 1024 * 1024,
      });
      const res = await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/session-hash-mismatch`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        sha256Hex(body),
      );
      expect(res.status).toBe(200);
      // Should start from 0 — all 3 chunks, not resume from 1 MB
      expect(received.length).toBe(3);
      expect(received[0]?.contentRange).toBe(`bytes 0-${1024 * 1024 - 1}/${body.byteLength}`);
    } finally {
      server.stop(true);
    }
  });

  it('resets to 0 on 409 and retries from the start', async () => {
    // Simulate: server scratch file was cleared between sweeps.
    // First chunk (resume from 1 MB) gets 409, then we reset and start from 0.
    const { port, received, server, clearScratch } = startChunkedMockServer();
    try {
      const body = new Uint8Array(2.5 * 1024 * 1024);
      crypto.getRandomValues(body);
      const bodyHash = sha256Hex(body);
      const marker = makeMarker('session-409', {
        body_hash: bodyHash,
        body_size: body.byteLength,
        bytes_uploaded: 1024 * 1024,
      });

      // Clear the scratch file so the resume attempt gets 409
      // The mock server returns 409 when start > 0 and scratch is empty
      clearScratch();

      const res = await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/session-409`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        bodyHash,
      );
      expect(res.status).toBe(200);
      // First request (resume from 1 MB) got 409, then 3 chunks from 0
      expect(received.length).toBe(4);
      // First request was the failed resume
      expect(received[0]?.contentRange).toBe(
        `bytes ${1024 * 1024}-${2 * 1024 * 1024 - 1}/${body.byteLength}`,
      );
      // Then 3 chunks from 0
      expect(received[1]?.contentRange).toBe(`bytes 0-${1024 * 1024 - 1}/${body.byteLength}`);
    } finally {
      server.stop(true);
    }
  });

  it('updates marker progress after each successful intermediate chunk', async () => {
    const { port, server } = startChunkedMockServer();
    try {
      const body = new Uint8Array(2.5 * 1024 * 1024);
      crypto.getRandomValues(body);
      const sessionId = 'session-progress';
      // Write the marker to disk so updateMarkerProgress can find it, and hand
      // uploadWithResume that same marker (progress writes skip a stale copy).
      writeShipMarker(sessionId, '/tmp/fake.jsonl', false);
      const marker = JSON.parse(
        readFileSync(join(tmpHome, 'ship-queue', `${sessionId}.json`), 'utf8'),
      ) as ShipMarker;

      await uploadWithResume(
        `http://localhost:${port}/v1/transcripts/${sessionId}`,
        body,
        { 'Content-Type': 'application/x-zstd' },
        marker,
        sha256Hex(body),
      );

      // After the upload, the marker on disk should have body_size and bytes_uploaded
      // updated (the final chunk triggers 200, so the marker gets deleted by the caller,
      // but intermediate chunks should have updated it). Since the mock server returns
      // 200 on the final chunk, the marker is NOT deleted by uploadWithResume (the
      // caller does that). But intermediate chunks DO update it.
      //
      // Actually, the marker file may have been deleted by writeShipMarker's tmp+rename
      // — let me check. writeShipMarker creates the marker, then uploadWithResume
      // updates it via updateMarkerProgress. The final state should reflect the last
      // intermediate chunk's progress (1 MB uploaded, body_size = 2.5 MB).
      const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);
      if (existsSync(markerPath)) {
        const updated = JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker;
        // After 2 intermediate chunks (1 MB each), bytes_uploaded should be 2 MB
        // and body_size should be the full body size.
        expect(updated.body_size).toBe(body.byteLength);
        expect(updated.bytes_uploaded).toBeGreaterThanOrEqual(1024 * 1024);
      }
    } finally {
      server.stop(true);
    }
  });
});

describe('shipper 401', () => {
  it('keeps the marker while the token is rejected, then ships once it is replaced', async () => {
    const sessionId = '5f0c1d52-8a3e-4b6f-9c1d-2e7a4b8d9f03';
    const transcriptPath = join(tmpTranscriptDir, `${sessionId}.jsonl`);
    writeTranscript(transcriptPath, [
      JSON.stringify({ message: { content: 'hello', role: 'user' }, type: 'user' }),
    ]);
    writeShipMarker(sessionId, transcriptPath, false);
    const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'stale-jwt' }));

    const server = Bun.serve({
      fetch: (req) =>
        req.headers.get('authorization') === 'Bearer fresh-jwt'
          ? new Response('{}', { status: 200 })
          : new Response('expired', { status: 401 }),
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;

    class Stop extends Error {}
    let sweeps = 0;
    let keptAfter401 = false;
    const spy = spyOn(Bun, 'sleep').mockImplementation((async () => {
      sweeps++;
      if (sweeps === 1) {
        // 401 sweep done: the marker used to be deleted here.
        keptAfter401 = existsSync(markerPath);
        writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'fresh-jwt' }));
      } else {
        throw new Stop();
      }
    }) as typeof Bun.sleep);
    try {
      await runShipper();
    } catch (err) {
      if (!(err instanceof Stop)) {
        throw err;
      }
    } finally {
      spy.mockRestore();
      server.stop(true);
    }

    expect(keptAfter401).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('shipper multi-chunk supersede check', () => {
  const SID = '9b1e7c34-2d5a-4f08-a6c3-1e8d7f4b2a90';

  /** Realistic JSONL transcript lines whose zstd body is well over one 1 MB
   * chunk: prose drawn from a large pseudo-random vocabulary, so it does not
   * compress to nothing the way repeated text would. */
  function bigTranscriptLines(): string[] {
    // Sized for 3+ chunks with margin, so progress writes happen between chunks.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const syl = ['ka', 'lo', 'mi', 'ren', 'tu', 'sa', 'vo', 'ni', 'pel', 'dra', 'qui', 'zen'];
    const vocab = Array.from({ length: 40_000 }, () => {
      const n = 2 + Math.floor(rand() * 3);
      return Array.from({ length: n }, () => syl[Math.floor(rand() * syl.length)]).join('');
    });
    const sentence = (words: number) =>
      Array.from({ length: words }, () => vocab[Math.floor(rand() * vocab.length)]).join(' ');
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i++) {
      lines.push(
        JSON.stringify(
          i % 2 === 0
            ? { message: { content: sentence(60), role: 'user' }, type: 'user', uuid: `u-${i}` }
            : {
                message: { content: [{ text: sentence(120), type: 'text' }], role: 'assistant' },
                type: 'assistant',
                uuid: `a-${i}`,
              },
        ),
      );
    }
    return lines;
  }

  /** Fake ingest that mimics the real route's chunk assembly: start=0 resets the
   * scratch file, a later chunk must start exactly where the scratch ends (else
   * 409), the final chunk answers 200. `onChunk(index, isFinal)` runs while that
   * request is in flight. */
  function startAssemblingIngest(onChunk?: (index: number, isFinal: boolean) => void) {
    let scratch = 0;
    const stats = { chunksAtStart0: 0, conflicts: 0, finals: 0, requests: 0 };
    const server = Bun.serve({
      async fetch(req) {
        stats.requests++;
        const body = new Uint8Array(await req.arrayBuffer());
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers.get('content-range') ?? '');
        if (!m) {
          return new Response('bad range', { status: 400 });
        }
        const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (start === 0) {
          stats.chunksAtStart0++;
          scratch = 0;
        } else if (scratch !== start) {
          stats.conflicts++;
          return new Response('Missing prior chunks', { status: 409 });
        }
        scratch += body.byteLength;
        const isFinal = end + 1 >= total;
        onChunk?.(stats.requests - 1, isFinal);
        if (!isFinal) {
          return new Response('{}', { status: 202 });
        }
        stats.finals++;
        scratch = 0;
        return new Response('{}', { status: 200 });
      },
      port: 0,
    });
    return { server, stats };
  }

  /** Run exactly one sweep: pacing sleeps are instant, the inter-sweep sleep stops the loop. */
  async function runOneSweep(): Promise<void> {
    class Stop extends Error {}
    const spy = spyOn(Bun, 'sleep').mockImplementation((async (ms: number) => {
      if (ms > 1_000) {
        throw new Stop();
      }
    }) as typeof Bun.sleep);
    try {
      await runShipper();
    } catch (err) {
      if (!(err instanceof Stop)) {
        throw err;
      }
    } finally {
      spy.mockRestore();
    }
  }

  function setup(): string {
    const transcriptPath = join(tmpTranscriptDir, `${SID}.jsonl`);
    writeTranscript(transcriptPath, bigTranscriptLines());
    writeShipMarker(SID, transcriptPath, false);
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'jwt' }));
    return join(tmpHome, 'ship-queue', `${SID}.json`);
  }

  it('uploads each chunk once and clears the marker with no re-upload or 409', async () => {
    const markerPath = setup();
    const { server, stats } = startAssemblingIngest();
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    let requestsAfterFirst: number;
    try {
      await runOneSweep();
      requestsAfterFirst = stats.requests;
      // A marker wrongly kept as "superseded" would be re-uploaded here.
      await runOneSweep();
    } finally {
      server.stop(true);
    }
    // The body really is multi-chunk, and was sent exactly once.
    expect(requestsAfterFirst).toBeGreaterThan(2);
    expect(stats.requests).toBe(requestsAfterFirst);
    expect(stats.chunksAtStart0).toBe(1);
    expect(stats.conflicts).toBe(0);
    expect(stats.finals).toBe(1);
    expect(existsSync(markerPath)).toBe(false);
  }, 60_000);

  /** A Stop: a fresh marker write whose updated_at must differ, so wait out the clock tick. */
  function stop(transcriptPath: string): void {
    const t = Date.now();
    while (Date.now() === t) {
      // spin
    }
    writeShipMarker(SID, transcriptPath, false);
  }

  it('keeps the marker when a Stop rewrites it while the final chunk is in flight', async () => {
    const markerPath = setup();
    const transcriptPath = join(tmpTranscriptDir, `${SID}.jsonl`);
    const { server, stats } = startAssemblingIngest((_i, isFinal) => {
      if (isFinal) {
        stop(transcriptPath);
      }
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runOneSweep();
    } finally {
      server.stop(true);
    }
    expect(stats.finals).toBe(1);
    expect(existsSync(markerPath)).toBe(true);
  }, 60_000);

  it('keeps the marker when a Stop lands between chunks (progress writes must not clobber it)', async () => {
    const markerPath = setup();
    const transcriptPath = join(tmpTranscriptDir, `${SID}.jsonl`);
    let stopped = false;
    const { server, stats } = startAssemblingIngest((i, isFinal) => {
      // While serving the first chunk: the uploader then writes progress from its stale copy.
      if (i === 0 && !isFinal) {
        stopped = true;
        stop(transcriptPath);
      }
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runOneSweep();
    } finally {
      server.stop(true);
    }
    expect(stopped).toBe(true);
    expect(stats.finals).toBe(1);
    expect(existsSync(markerPath)).toBe(true);
  }, 60_000);

  it('keeps the marker when a Stop lands while the body is being built', async () => {
    const markerPath = setup();
    // The transcript is a FIFO: the body build blocks reading it until the
    // writer below has injected a Stop, so the Stop lands deterministically
    // between the marker snapshot and the upload.
    const fifo = join(tmpTranscriptDir, `${SID}.fifo`);
    Bun.spawnSync(['mkfifo', fifo]);
    writeShipMarker(SID, fifo, false);
    const writer = (async () => {
      const fh = await open(fifo, 'w');
      await fh.write(
        `${JSON.stringify({ message: { content: 'hi', role: 'user' }, type: 'user' })}\n`,
      );
      stop(fifo);
      await fh.close();
    })();
    const { server, stats } = startAssemblingIngest();
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runOneSweep();
      await writer;
    } finally {
      server.stop(true);
    }
    expect(stats.finals).toBe(1);
    expect(existsSync(markerPath)).toBe(true);
  }, 60_000);

  it('keeps the marker when an older hook binary rewrites it without updated_at', async () => {
    const markerPath = setup();
    const { server, stats } = startAssemblingIngest((_i, isFinal) => {
      if (isFinal) {
        // Rolling upgrade: a not-yet-updated hook rewrites the marker with no updated_at.
        const m = JSON.parse(readFileSync(markerPath, 'utf8'));
        delete m.updated_at;
        writeFileSync(markerPath, JSON.stringify(m));
      }
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runOneSweep();
    } finally {
      server.stop(true);
    }
    expect(stats.finals).toBe(1);
    expect(existsSync(markerPath)).toBe(true);
  }, 60_000);

  it('treats a marker without updated_at (older version) as unchanged', async () => {
    const markerPath = setup();
    const legacy = JSON.parse(readFileSync(markerPath, 'utf8'));
    delete legacy.updated_at;
    writeFileSync(markerPath, JSON.stringify(legacy));
    const { server, stats } = startAssemblingIngest();
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runOneSweep();
    } finally {
      server.stop(true);
    }
    expect(stats.conflicts).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  }, 60_000);
});

describe('shipper outage handling', () => {
  const S1 = '5f0c1d52-8a3e-4b6f-9c1d-2e7a4b8d9f03';
  const S2 = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  function stage(sessionId: string, firstSeenAt?: string): string {
    const transcriptPath = join(tmpTranscriptDir, `${sessionId}.jsonl`);
    writeTranscript(transcriptPath, [
      JSON.stringify({ message: { content: 'hello', role: 'user' }, type: 'user' }),
    ]);
    writeShipMarker(sessionId, transcriptPath, false);
    const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);
    if (firstSeenAt) {
      const m = JSON.parse(readFileSync(markerPath, 'utf8')) as ShipMarker;
      writeFileSync(markerPath, JSON.stringify({ ...m, first_seen_at: firstSeenAt }));
    }
    return markerPath;
  }

  /** Run `sweeps` sweeps of the real loop (each ends in one Bun.sleep). */
  async function runSweeps(sweeps: number, onSleep?: (n: number) => void): Promise<void> {
    class Stop extends Error {}
    let n = 0;
    const spy = spyOn(Bun, 'sleep').mockImplementation((async () => {
      onSleep?.(n + 1);
      if (++n >= sweeps) {
        throw new Stop();
      }
    }) as typeof Bun.sleep);
    try {
      await runShipper();
    } catch (err) {
      if (!(err instanceof Stop)) {
        throw err;
      }
    } finally {
      spy.mockRestore();
    }
  }

  function setToken(): void {
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'some-jwt' }));
  }

  it('keeps a long-lived session marker on 401 (first_seen_at is the SESSION age)', async () => {
    setToken();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    const marker = stage(S1, threeDaysAgo);
    const server = Bun.serve({ fetch: () => new Response('no', { status: 401 }), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runSweeps(1);
    } finally {
      server.stop(true);
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('stops the sweep at the first 401 instead of repeating it per marker', async () => {
    setToken();
    stage(S1);
    stage(S2);
    let requests = 0;
    const server = Bun.serve({
      fetch: () => {
        requests++;
        return new Response('no', { status: 401 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runSweeps(1);
    } finally {
      server.stop(true);
    }
    expect(requests).toBe(1);
  });

  it('abandons a marker that nothing has touched for 7 days, even on 401', async () => {
    setToken();
    const marker = stage(S1);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000);
    utimesSync(marker, eightDaysAgo, eightDaysAgo);
    const server = Bun.serve({ fetch: () => new Response('no', { status: 401 }), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runSweeps(1);
    } finally {
      server.stop(true);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('does not burn attempts on network errors: survives far more than MAX_SHIP_ATTEMPTS sweeps', async () => {
    setToken();
    const marker = stage(S1);
    const dead = Bun.serve({ fetch: () => new Response('x'), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    await runSweeps(15);
    expect(existsSync(marker)).toBe(true);
    expect((JSON.parse(readFileSync(marker, 'utf8')) as ShipMarker).attempts ?? 0).toBe(0);
  });

  it('abandons an idle marker on network errors once past 7 days', async () => {
    setToken();
    const marker = stage(S1);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000);
    utimesSync(marker, eightDaysAgo, eightDaysAgo);
    const dead = Bun.serve({ fetch: () => new Response('x'), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    await runSweeps(1);
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps a long-lived session marker on 404 (the flusher may still be catching up)', async () => {
    setToken();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    const marker = stage(S1, threeDaysAgo);
    const server = Bun.serve({ fetch: () => new Response('no session', { status: 404 }), port: 0 });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runSweeps(1);
    } finally {
      server.stop(true);
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('skips whole sweeps while the token is the rejected one, retrying a changed token at once', async () => {
    setToken();
    stage(S1);
    const auths: Array<string | null> = [];
    const server = Bun.serve({
      fetch: (req) => {
        auths.push(req.headers.get('authorization'));
        return new Response('no', { status: 401 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      await runSweeps(5, (n) => {
        if (n === 3) {
          writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'newer-jwt' }));
        }
      });
    } finally {
      server.stop(true);
    }
    // sweep 1 probes (401); sweeps 2-3 skip; token changes; sweep 4 probes the new
    // token (401); sweep 5 skips. No transcript is read or uploaded on a skip.
    expect(auths).toEqual(['Bearer some-jwt', 'Bearer newer-jwt']);
  });

  it('re-probes a rejected token after 15 minutes', async () => {
    setToken();
    stage(S1);
    let requests = 0;
    const server = Bun.serve({
      fetch: () => {
        requests++;
        return new Response('no', { status: 401 });
      },
      port: 0,
    });
    process.env.INGEST_BASE_URL = `http://127.0.0.1:${server.port}`;
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      await runSweeps(4, (n) => {
        if (n === 2) {
          skew = 16 * 60_000;
        }
      });
    } finally {
      nowSpy.mockRestore();
      server.stop(true);
    }
    // sweep 1 probes; sweep 2 skips; the clock jumps 16 min; sweep 3 re-probes.
    expect(requests).toBe(2);
  });
});

describe('shipper follows queue.db across purge-local', () => {
  it('reopens the new queue.db within seconds, not at the next 10-minute sweep', async () => {
    const queueDb = join(tmpHome, 'queue.db');
    const before = openQueue(); // the file the daemon opens at start
    before.close();

    const openSpy = spyOn(queueReader, 'openQueueReader');
    class Stop extends Error {}
    let calls = 0;
    let opens = -1;
    const started = Date.now();
    let replacedAfterMs = -1;
    // The long sweep wait never ends on its own: only the early wake-up can end it.
    const spy = spyOn(Bun, 'sleep').mockImplementation((() => {
      calls++;
      if (calls === 1) {
        // What `aiot purge-local` does while the daemon waits: unlink, and the next
        // hook creates a fresh queue.db.
        setTimeout(() => {
          for (const suffix of ['', '-wal', '-shm']) {
            rmSync(`${queueDb}${suffix}`, { force: true });
          }
          openQueue().close();
          replacedAfterMs = Date.now() - started;
        }, 200);
        return new Promise<void>(() => {});
      }
      throw new Stop();
    }) as unknown as typeof Bun.sleep);
    try {
      await runShipper();
    } catch (err) {
      if (!(err instanceof Stop)) {
        throw err;
      }
    } finally {
      opens = openSpy.mock.calls.length;
      spy.mockRestore();
      openSpy.mockRestore();
    }

    expect(opens).toBe(2); // at start, and again for the new file
    expect(replacedAfterMs).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(15_000); // QUEUE_POLL_MS is 5 s
    expect(readFileSync(join(tmpHome, 'hook.log'), 'utf8')).toContain('"shipper.queue_replaced"');
  }, 30_000);
});
