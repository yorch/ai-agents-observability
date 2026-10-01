import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newSessionId, writeTranscript } from '../lib/e2e-harness';
import { LEASE_TTL_MS } from '../lib/lease';
import { openQueue } from '../lib/queue';
import { runImport } from './import';

// `aiot import` holds the transcripts lease for the length of the import. If it
// loses it (a suspend, a clock step) a drainer may take the expired row and upload
// chunks for the same session; an import POST still in flight beside that is a
// sequence the server was never specified for. The lease's abort signal has to reach
// the import's own requests, not just be polled between sessions.

let home: string;
const saved: Record<string, string | undefined> = {};
let server: ReturnType<typeof Bun.serve> | null = null;

function setEnv(name: string, value: string): void {
  if (!(name in saved)) {
    saved[name] = process.env[name];
  }
  process.env[name] = value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiot-import-lease-'));
  setEnv('AIOT_HOME', home);
  setEnv('AIOT_CONFIG', join(home, 'config.json'));
  setEnv('CLAUDE_PROJECTS_DIR', join(home, 'projects'));
  writeFileSync(join(home, 'identity.json'), JSON.stringify({ token: 'cct_test' }));
});

afterEach(() => {
  server?.stop(true);
  server = null;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    delete saved[name];
  }
  rmSync(home, { force: true, recursive: true });
});

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await fn(), stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

describe('aiot import losing its lease mid-upload', () => {
  it('stops the in-flight upload and exits cleanly, not 8 s later and not as a network error', async () => {
    const id = newSessionId();
    writeTranscript(join(home, 'projects', 'widgets', `${id}.jsonl`), id, home, 2);

    let transcriptRequests = 0;
    let released = 0;
    server = Bun.serve({
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/health') {
          return Response.json({ status: 'ok' });
        }
        if (path === '/v1/events') {
          return Response.json({ accepted: 1, deduped: 0, rejected: 0 });
        }
        transcriptRequests += 1;
        // A second process takes the expired lease while our upload is in flight...
        const q = openQueue();
        q.db
          .query(
            "UPDATE delivery_lease SET token = 'drainer', pid = 999999, role = 'drain', started_at = ?, expires_at = ? WHERE kind = 'transcripts'",
          )
          .run(Date.now(), Date.now() + LEASE_TTL_MS);
        q.close();
        // ...and the server is slow to answer.
        await Bun.sleep(9_000);
        released = Date.now();
        return Response.json({ ok: true });
      },
      port: 0,
    });
    setEnv('INGEST_BASE_URL', `http://127.0.0.1:${server.port}`);

    const started = Date.now();
    const { code, stderr } = await captureStderr(() => runImport(['import', '--quiet']));
    const elapsed = Date.now() - started;

    expect(transcriptRequests).toBe(1);
    // The renewal tick (5 s) notices the loss and aborts the request: well before
    // the server would have answered.
    expect(code).toBe(1);
    expect(elapsed).toBeLessThan(8_000);
    expect(released).toBe(0);
    expect(stderr).toContain('lost the delivery lease');
    // A stop of our own is reported as one: no per-session WARNING, no network error.
    expect(stderr).not.toContain('WARNING');
    expect(stderr).not.toContain('Network error');
  }, 30_000);
});
