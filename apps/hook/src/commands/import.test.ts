import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runImport } from './import';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSessionFile(dir: string, sessionId: string, entries: object[]): string {
  mkdirSync(join(dir, 'proj'), { recursive: true });
  const path = join(dir, 'proj', `${sessionId}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  return path;
}

// Minimal valid user entry
const userEntry = (sessionId: string, uuid: string, ts = '2025-01-01T00:00:00.000Z'): object => ({
  cwd: '/tmp/test',
  message: { content: 'hello', role: 'user' },
  sessionId,
  timestamp: ts,
  type: 'user',
  uuid,
  version: '1.0.0',
});

// Minimal valid assistant entry with one tool_use and usage
const assistantEntry = (
  sessionId: string,
  uuid: string,
  toolUseId: string,
  ts = '2025-01-01T00:00:01.000Z',
): object => ({
  cwd: '/tmp/test',
  message: {
    content: [{ id: toolUseId, input: { command: 'ls' }, name: 'Bash', type: 'tool_use' }],
    model: 'claude-opus-4-5',
    role: 'assistant',
    stop_reason: 'tool_use',
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
    },
  },
  sessionId,
  timestamp: ts,
  type: 'assistant',
  uuid,
  version: '1.0.0',
});

// A user entry with a tool_result block
const toolResultEntry = (
  sessionId: string,
  uuid: string,
  toolUseId: string,
  ts = '2025-01-01T00:00:02.000Z',
): object => ({
  cwd: '/tmp/test',
  message: {
    content: [{ content: 'ok', tool_use_id: toolUseId, type: 'tool_result' }],
    role: 'user',
  },
  sessionId,
  timestamp: ts,
  type: 'user',
  uuid,
  version: '1.0.0',
});

// ── Server helpers ────────────────────────────────────────────────────────────

type ReceivedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function startMockServer(options: {
  eventsStatus?: number;
  transcriptStatus?: number;
  eventsResponse?: object;
  readyzStatus?: number;
  readyzChecks?: { postgres?: string; s3?: string };
}): {
  port: number;
  received: ReceivedRequest[];
  server: ReturnType<typeof Bun.serve>;
} {
  const {
    eventsStatus = 202,
    transcriptStatus = 201,
    eventsResponse,
    readyzStatus = 200,
    readyzChecks = { postgres: 'ok', s3: 'ok' },
  } = options;
  const received: ReceivedRequest[] = [];

  const server = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const contentType = req.headers.get('content-type') ?? '';

      let body: unknown = null;
      if (contentType.includes('application/json')) {
        body = await req.json().catch(() => null);
      } else {
        body = await req.arrayBuffer().catch(() => null);
      }

      const headers: Record<string, string> = {};
      req.headers.forEach((val, key) => {
        headers[key] = val;
      });

      received.push({ body, headers, method: req.method, url: pathname });

      if (req.method === 'GET' && pathname === '/readyz') {
        const ok = readyzStatus < 300;
        return new Response(JSON.stringify({ checks: readyzChecks, ok }), {
          headers: { 'Content-Type': 'application/json' },
          status: readyzStatus,
        });
      }
      if (req.method === 'POST' && pathname === '/v1/events') {
        const responseBody = eventsResponse ?? { accepted: 3, deduped: 0, rejected: 0 };
        return new Response(JSON.stringify(responseBody), {
          headers: { 'Content-Type': 'application/json' },
          status: eventsStatus,
        });
      }
      if (req.method === 'POST' && pathname.startsWith('/v1/transcripts/')) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: transcriptStatus,
        });
      }
      return new Response('not found', { status: 404 });
    },
    port: 0, // random port
  });

  return { port: server.port, received, server };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let tmpHome: string;
let tmpProjects: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'import-test-home-'));
  tmpProjects = mkdtempSync(join(tmpdir(), 'import-test-projects-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
  process.env.CLAUDE_PROJECTS_DIR = tmpProjects;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  rmSync(tmpProjects, { force: true, recursive: true });
  delete process.env.CLAUDE_TELEMETRY_HOME;
  delete process.env.CLAUDE_PROJECTS_DIR;
  delete process.env.INGEST_BASE_URL;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runImport — auth checks', () => {
  it('returns 1 when no auth token and no --dry-run', async () => {
    // tmpHome has no identity.json, so loadHookToken() returns null
    const sessionId = 'session-noauth-001';
    makeSessionFile(tmpProjects, sessionId, [
      userEntry(sessionId, 'uuid-001'),
      assistantEntry(sessionId, 'uuid-002', 'tool-001'),
    ]);

    const code = await runImport(['import']);
    expect(code).toBe(1);
  });

  it('--dry-run without auth returns 0 and makes no fetch calls', async () => {
    const sessionId = 'session-dryrun-001';
    makeSessionFile(tmpProjects, sessionId, [
      userEntry(sessionId, 'uuid-001'),
      assistantEntry(sessionId, 'uuid-002', 'tool-001'),
      toolResultEntry(sessionId, 'uuid-003', 'tool-001'),
    ]);

    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
      fetchCalls.push(String(input));
      return origFetch(input, _init);
    };

    try {
      const code = await runImport(['import', '--dry-run', '--quiet']);
      expect(code).toBe(0);
      expect(fetchCalls.length).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('runImport — happy path', () => {
  it('POSTs events before transcript, transcript has correct headers', async () => {
    const sessionId = 'session-happy-001';
    makeSessionFile(tmpProjects, sessionId, [
      userEntry(sessionId, 'uuid-001'),
      assistantEntry(sessionId, 'uuid-002', 'tool-001'),
      toolResultEntry(sessionId, 'uuid-003', 'tool-001'),
    ]);

    // Write auth token
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');

    const { port, received, server } = startMockServer({});
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const code = await runImport(['import', '--quiet']);
      expect(code).toBe(0);

      // Find events POST and transcript POST
      const eventsIdx = received.findIndex((r) => r.method === 'POST' && r.url === '/v1/events');
      const transcriptIdx = received.findIndex(
        (r) => r.method === 'POST' && r.url.startsWith('/v1/transcripts/'),
      );

      expect(eventsIdx).toBeGreaterThanOrEqual(0);
      expect(transcriptIdx).toBeGreaterThanOrEqual(0);
      // Events must be posted before transcript
      expect(eventsIdx).toBeLessThan(transcriptIdx);

      // Transcript must have the required headers
      const transcriptReq = received[transcriptIdx];
      expect(transcriptReq?.headers['content-type']).toBe('application/x-zstd');
      expect(transcriptReq?.headers['x-content-hash']).toBeTruthy();
    } finally {
      server.stop(true);
    }
  });
});

describe('runImport — batch size', () => {
  it('splits >100 events into multiple /v1/events calls', async () => {
    // Each assistantEntry with 1 tool_use → Stop + PreToolUse = 2 events
    // 60 assistant entries → 120 events → 2 batches (100 + 20)
    // Plus toolResult entries → PostToolUse events
    const sessionId = 'session-batch-001';
    const entries: object[] = [userEntry(sessionId, 'uuid-user-000')];

    for (let i = 0; i < 60; i++) {
      const uuid = `uuid-asst-${String(i).padStart(3, '0')}`;
      const toolId = `tool-id-${String(i).padStart(3, '0')}`;
      entries.push(assistantEntry(sessionId, uuid, toolId));
    }

    makeSessionFile(tmpProjects, sessionId, entries);

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');

    const { port, received, server } = startMockServer({
      eventsResponse: { accepted: 100, deduped: 0, rejected: 0 },
    });
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const code = await runImport(['import', '--no-transcripts', '--quiet']);
      expect(code).toBe(0);

      const eventsRequests = received.filter((r) => r.method === 'POST' && r.url === '/v1/events');
      // 60 assistant entries × 2 events each = 120 events → at least 2 batches
      expect(eventsRequests.length).toBeGreaterThanOrEqual(2);

      // Each individual batch must have at most 100 events
      for (const req of eventsRequests) {
        const body = req.body as { events?: unknown[] };
        if (body?.events) {
          expect(body.events.length).toBeLessThanOrEqual(100);
        }
      }
    } finally {
      server.stop(true);
    }
  });
});

describe('runImport — 401 handling', () => {
  it('returns 1 on 401 from server', async () => {
    const sessionId = 'session-401-001';
    makeSessionFile(tmpProjects, sessionId, [
      userEntry(sessionId, 'uuid-001'),
      assistantEntry(sessionId, 'uuid-002', 'tool-001'),
    ]);

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'bad-token' }), 'utf8');

    const { port, server } = startMockServer({ eventsStatus: 401 });
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const code = await runImport(['import', '--quiet']);
      expect(code).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe('runImport — error tolerance', () => {
  it('warns on malformed session file, continues with valid session, returns 0', async () => {
    // Create one completely invalid file
    mkdirSync(join(tmpProjects, 'proj'), { recursive: true });
    writeFileSync(join(tmpProjects, 'proj', 'bad-session.jsonl'), '}{garbage}{', 'utf8');

    // Create one valid session (in a different project dir to avoid conflicts)
    const sessionId = 'session-valid-001';
    const validPath = join(tmpProjects, 'proj2', `${sessionId}.jsonl`);
    mkdirSync(join(tmpProjects, 'proj2'), { recursive: true });
    writeFileSync(
      validPath,
      [
        JSON.stringify(userEntry(sessionId, 'uuid-001')),
        JSON.stringify(assistantEntry(sessionId, 'uuid-002', 'tool-001')),
      ].join('\n'),
      'utf8',
    );

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');

    const { port, received, server } = startMockServer({});
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const code = await runImport(['import', '--quiet']);
      expect(code).toBe(0);

      // The valid session's events should still have been POSTed
      const eventsRequests = received.filter((r) => r.method === 'POST' && r.url === '/v1/events');
      expect(eventsRequests.length).toBeGreaterThanOrEqual(1);
    } finally {
      server.stop(true);
    }
  });
});

describe('runImport — --no-transcripts', () => {
  it('makes no /v1/transcripts calls when --no-transcripts is passed', async () => {
    const sessionId = 'session-notranscript-001';
    makeSessionFile(tmpProjects, sessionId, [
      userEntry(sessionId, 'uuid-001'),
      assistantEntry(sessionId, 'uuid-002', 'tool-001'),
    ]);

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');

    const { port, received, server } = startMockServer({});
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const code = await runImport(['import', '--no-transcripts', '--quiet']);
      expect(code).toBe(0);

      const transcriptRequests = received.filter(
        (r) => r.method === 'POST' && r.url.startsWith('/v1/transcripts/'),
      );
      expect(transcriptRequests.length).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

describe('runImport — pre-flight server check', () => {
  it('returns 1 and prints error when server is unreachable', async () => {
    const sessionId = 'session-preflight-001';
    makeSessionFile(tmpProjects, sessionId, [userEntry(sessionId, 'uuid-001')]);

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');
    // Point at a port nothing is listening on
    process.env.INGEST_BASE_URL = 'http://localhost:1';

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    try {
      const code = await runImport(['import', '--quiet']);
      expect(code).toBe(1);
      expect(stderrChunks.join('')).toMatch(/cannot reach ingest server/i);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('returns 1 when server /readyz returns 503', async () => {
    const sessionId = 'session-preflight-002';
    makeSessionFile(tmpProjects, sessionId, [userEntry(sessionId, 'uuid-001')]);

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');

    const { port, received, server } = startMockServer({
      readyzChecks: { postgres: 'error', s3: 'ok' },
      readyzStatus: 503,
    });
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    try {
      const code = await runImport(['import', '--quiet']);
      expect(code).toBe(1);
      const stderr = stderrChunks.join('');
      expect(stderr).toMatch(/server not ready/i);
      expect(stderr).toMatch(/postgres/);
      // No events should have been POSTed
      expect(received.filter((r) => r.url === '/v1/events').length).toBe(0);
    } finally {
      server.stop(true);
      process.stderr.write = origWrite;
    }
  });

  it('skips pre-flight check on --dry-run', async () => {
    const sessionId = 'session-preflight-003';
    makeSessionFile(tmpProjects, sessionId, [userEntry(sessionId, 'uuid-001')]);

    // No server at all — dry-run should still succeed
    process.env.INGEST_BASE_URL = 'http://localhost:1';

    const code = await runImport(['import', '--dry-run', '--quiet']);
    expect(code).toBe(0);
  });
});

describe('runImport — --session filter', () => {
  it('only processes the specified session when --session is passed', async () => {
    // Create two sessions in different project dirs
    const sessionId1 = 'session-filter-001';
    const sessionId2 = 'session-filter-002';

    mkdirSync(join(tmpProjects, 'proj1'), { recursive: true });
    writeFileSync(
      join(tmpProjects, 'proj1', `${sessionId1}.jsonl`),
      [
        JSON.stringify(userEntry(sessionId1, 'uuid-s1-001')),
        JSON.stringify(assistantEntry(sessionId1, 'uuid-s1-002', 'tool-s1-001')),
      ].join('\n'),
      'utf8',
    );

    mkdirSync(join(tmpProjects, 'proj2'), { recursive: true });
    writeFileSync(
      join(tmpProjects, 'proj2', `${sessionId2}.jsonl`),
      [
        JSON.stringify(userEntry(sessionId2, 'uuid-s2-001')),
        JSON.stringify(assistantEntry(sessionId2, 'uuid-s2-002', 'tool-s2-001')),
      ].join('\n'),
      'utf8',
    );

    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: 'test-token' }), 'utf8');

    const { port, received, server } = startMockServer({});
    process.env.INGEST_BASE_URL = `http://localhost:${port}`;

    try {
      const code = await runImport([
        'import',
        '--session',
        sessionId1,
        '--no-transcripts',
        '--quiet',
      ]);
      expect(code).toBe(0);

      // Only one batch of events should have been sent (for sessionId1 only)
      const eventsRequests = received.filter((r) => r.method === 'POST' && r.url === '/v1/events');
      // Only sessionId1's events were processed
      expect(eventsRequests.length).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
