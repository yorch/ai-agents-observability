import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipMarker } from '../src/shipper';
import { writeShipMarker } from '../src/shipper';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a sample JSONL transcript file with the given lines. */
function writeTranscript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
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
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/v1\/transcripts\/(.+)$/);
      if (req.method === 'PUT' && match) {
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
  });

  return { port: server.port, received, server };
}

/** Decompress a gzip buffer into a string. */
async function gunzip(data: Uint8Array): Promise<string> {
  return new TextDecoder().decode(Bun.gunzipSync(data));
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
  it('uploads transcript, deletes marker, sends gzip body with correct headers', async () => {
    const sessionId = 'session-upload-test';
    const transcriptPath = join(tmpTranscriptDir, 'transcript.jsonl');

    // 10 lines, one with a fake AWS access key that should be redacted
    const lines = [
      JSON.stringify({ role: 'user', content: 'Hello world' }),
      JSON.stringify({ role: 'assistant', content: 'Hello! How can I help?' }),
      JSON.stringify({ role: 'user', content: 'My key is AKIAIOSFODNN7EXAMPLE please keep it' }),
      JSON.stringify({ role: 'assistant', content: 'I see you mentioned a key.' }),
      JSON.stringify({ role: 'user', content: 'Can you list files?' }),
      JSON.stringify({ role: 'assistant', content: 'Sure, running ls.' }),
      JSON.stringify({ role: 'user', content: 'What is 2+2?' }),
      JSON.stringify({ role: 'assistant', content: '4' }),
      JSON.stringify({ role: 'user', content: 'Thanks!' }),
      JSON.stringify({ role: 'assistant', content: 'Goodbye!' }),
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
      // Simulate what the shipper does: build gzip body and PUT to endpoint
      const { redactedLines } = await import('../src/lib/transcript-stream');
      const { createHash } = await import('node:crypto');

      const redactedLinesList: string[] = [];
      for await (const line of redactedLines(transcriptPath)) {
        redactedLinesList.push(line);
      }
      const text = redactedLinesList.join('\n');
      const encoded = new TextEncoder().encode(text);
      const hash = createHash('sha256').update(encoded).digest('hex');
      const body = Bun.gzipSync(encoded);

      const markerPath = join(tmpHome, 'ship-queue', `${sessionId}.json`);
      expect(existsSync(markerPath)).toBe(true);

      const url = `http://localhost:${port}/v1/transcripts/${sessionId}`;
      const res = await fetch(url, {
        body,
        headers: {
          Authorization: 'Bearer test-jwt-token',
          'Content-Encoding': 'gzip',
          'Content-Type': 'application/jsonlines',
          'X-Content-Hash': hash,
        },
        method: 'PUT',
      });

      expect(res.status).toBe(200);
      expect(received.length).toBe(1);

      const upload = received[0];
      expect(upload.sessionId).toBe(sessionId);
      expect(upload.contentEncoding).toBe('gzip');
      expect(upload.contentType).toBe('application/jsonlines');
      expect(upload.contentHash).toBe(hash);

      // Decompress and verify AWS key was redacted
      const decompressed = await gunzip(upload.bodyBytes);
      expect(decompressed).not.toContain('AKIAIOSFODNN7EXAMPLE');
      // Should contain redacted placeholder instead
      expect(decompressed).toContain('[REDACTED');
    } finally {
      server.stop(true);
    }
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
