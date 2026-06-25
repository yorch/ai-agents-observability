import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { ShipMarker } from './shipper';
import { buildZstdBody, writeShipMarker } from './shipper';

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
        const sessionId = match[1];
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

  return { port: server.port, received, server };
}

/** Decompress a zstd buffer into a string. */
async function zstdDecompress(data: Uint8Array): Promise<string> {
  return new TextDecoder().decode(zstdDecompressSync(data));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpHome: string;
let tmpTranscriptDir: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'claude-tel-shipper-test-'));
  tmpTranscriptDir = mkdtempSync(join(tmpdir(), 'claude-tel-transcripts-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  rmSync(tmpTranscriptDir, { force: true, recursive: true });
  delete process.env.CLAUDE_TELEMETRY_HOME;
  delete process.env.INGEST_BASE_URL;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeShipMarker', () => {
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
      expect(upload.sessionId).toBe(sessionId);
      expect(upload.contentEncoding).toBeNull();
      expect(upload.contentType).toBe('application/x-zstd');
      expect(upload.contentHash).toBe(hash);

      // Decompress and verify AWS key was redacted
      const decompressed = await zstdDecompress(upload.bodyBytes);
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
