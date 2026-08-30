import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLogin } from './login';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;
let origFetch: typeof fetch;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'claude-tel-login-test-'));
  process.env.CLAUDE_TELEMETRY_CONFIG = join(tmpHome, 'config.json');
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
  process.env.CLAUDE_TELEMETRY_API = 'http://localhost:9999';
  origFetch = globalThis.fetch;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  globalThis.fetch = origFetch;
  delete process.env.CLAUDE_TELEMETRY_API;
  delete process.env.CLAUDE_TELEMETRY_CONFIG;
  delete process.env.CLAUDE_TELEMETRY_HOME;
});

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  let code: number;
  try {
    code = await fn();
  } finally {
    process.stderr.write = orig;
  }
  return { code, stderr: chunks.join('') };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('login device flow error messages', () => {
  it('surfaces request_id from a structured server error (502)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Device flow start failed', request_id: 'abc-123' }), {
        headers: { 'content-type': 'application/json' },
        status: 502,
      })) as unknown as typeof fetch;

    const { code, stderr } = await captureStderr(() => runLogin());
    expect(code).toBe(1);
    expect(stderr).toContain('502');
    expect(stderr).toContain('abc-123');
    expect(stderr).toContain('Server returned an error');
    expect(stderr).not.toContain('reachable');
  });

  it('keeps the reachability hint for a non-JSON proxy error', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        headers: { 'content-type': 'text/html' },
        status: 502,
      })) as unknown as typeof fetch;

    const { code, stderr } = await captureStderr(() => runLogin());
    expect(code).toBe(1);
    expect(stderr).toContain('502');
    expect(stderr).toContain('reachable');
    expect(stderr).not.toContain('request_id');
  });

  it('sanitizes request_id — strips non-URL-safe chars', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'fail', request_id: 'abc\x1b[2J;rm-rf' }), {
        headers: { 'content-type': 'application/json' },
        status: 502,
      })) as unknown as typeof fetch;

    const { stderr } = await captureStderr(() => runLogin());
    expect(stderr).toContain('abc2Jrm-rf');
    expect(stderr).not.toContain('\x1b');
  });
});
