import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../hook-entry';
import { runPause } from './pause';
import { runPurge } from './purge';
import { runResume } from './resume';
import { runStatus } from './status';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'claude-tel-cli-test-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.CLAUDE_TELEMETRY_HOME;
});

// Capture stdout/stderr for assertions
function captureOutput(fn: () => void): { stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  };

  try {
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') };
}

async function captureOutputAsync(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  };

  try {
    await fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') };
}

// ── pause / resume ────────────────────────────────────────────────────────────

describe('pause', () => {
  it('creates the paused marker file', () => {
    const exitCode = runPause();
    expect(exitCode).toBe(0);
    expect(existsSync(join(tmpHome, 'paused'))).toBe(true);
  });

  it('prints a confirmation message', () => {
    const { stdout } = captureOutput(() => runPause());
    expect(stdout).toContain('paused');
  });

  it('is idempotent — second pause still exits 0', () => {
    runPause();
    const exitCode = runPause();
    expect(exitCode).toBe(0);
  });
});

describe('resume', () => {
  it('removes the paused marker', () => {
    runPause();
    expect(existsSync(join(tmpHome, 'paused'))).toBe(true);
    const exitCode = runResume();
    expect(exitCode).toBe(0);
    expect(existsSync(join(tmpHome, 'paused'))).toBe(false);
  });

  it('is safe when no marker exists', () => {
    const exitCode = runResume();
    expect(exitCode).toBe(0);
  });

  it('prints a confirmation message', () => {
    const { stdout } = captureOutput(() => runResume());
    expect(stdout).toContain('resumed');
  });
});

// ── hook-entry pause check ────────────────────────────────────────────────────

describe('hook-entry when paused', () => {
  it('skips enqueueing when paused marker is present', async () => {
    // Create paused marker
    writeFileSync(join(tmpHome, 'paused'), '');

    // runHook should return without creating a queue.db
    await runHook('pre-tool-use', { quiet: false });

    expect(existsSync(join(tmpHome, 'queue.db'))).toBe(false);
  });

  it('enqueues normally when not paused', async () => {
    // Without a paused marker, runHook proceeds past the pause check and tries
    // to read stdin. In this test stdin is empty, so it logs hook.stdin.empty
    // and returns without creating a queue entry. We verify the log file is
    // written — proving the pause check did NOT short-circuit execution.
    await runHook('pre-tool-use', { quiet: false });

    expect(existsSync(join(tmpHome, 'hook.log'))).toBe(true);
    const log = readFileSync(join(tmpHome, 'hook.log'), 'utf8');
    expect(log).toContain('hook.stdin');
  });
});

// ── purge-local ───────────────────────────────────────────────────────────────

describe('purge-local', () => {
  it('prints a prompt and returns 1 without --yes', async () => {
    let exitCode: number | undefined;
    const { stdout } = await captureOutputAsync(async () => {
      exitCode = await runPurge([]);
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('server-side data');
  });

  it('removes local files with --yes', async () => {
    // Create some files to purge
    writeFileSync(join(tmpHome, 'queue.db'), 'data');
    writeFileSync(join(tmpHome, 'identity.json'), '{}');
    writeFileSync(join(tmpHome, 'paused'), '');
    writeFileSync(join(tmpHome, 'hook.log'), 'logs');
    writeFileSync(join(tmpHome, 'flusher-state.json'), '{}');

    const exitCode = await runPurge(['--yes']);
    expect(exitCode).toBe(0);

    expect(existsSync(join(tmpHome, 'queue.db'))).toBe(false);
    expect(existsSync(join(tmpHome, 'identity.json'))).toBe(false);
    expect(existsSync(join(tmpHome, 'paused'))).toBe(false);
  });

  it('returns 0 when nothing to remove', async () => {
    const { stdout } = await captureOutputAsync(async () => {
      const exitCode = await runPurge(['--yes']);
      expect(exitCode).toBe(0);
    });
    expect(stdout).toContain('Nothing to remove');
  });

  it('mentions the privacy URL', async () => {
    const { stdout } = await captureOutputAsync(async () => {
      await runPurge([]);
    });
    expect(stdout).toContain('/me/privacy');
  });
});

// ── status ────────────────────────────────────────────────────────────────────

describe('status', () => {
  it('shows not logged in when no identity.json', async () => {
    const { stdout } = await captureOutputAsync(async () => {
      await runStatus();
    });
    expect(stdout).toContain('not logged in');
  });

  it('shows logged-in username when identity.json has a token', async () => {
    writeFileSync(
      join(tmpHome, 'identity.json'),
      JSON.stringify({ token: 'cct_test', user_id_claim: 'octocat' }),
      { encoding: 'utf8', mode: 0o600 },
    );
    const { stdout } = await captureOutputAsync(async () => {
      await runStatus();
    });
    expect(stdout).toContain('logged in as octocat');
  });

  it('reports paused state when marker exists', async () => {
    writeFileSync(join(tmpHome, 'paused'), '');
    const { stdout } = await captureOutputAsync(async () => {
      await runStatus();
    });
    expect(stdout).toMatch(/paused:\s+yes/);
  });

  it('reports not paused when no marker', async () => {
    const { stdout } = await captureOutputAsync(async () => {
      await runStatus();
    });
    expect(stdout).toMatch(/paused:\s+no/);
  });

  it('shows last flush from flusher-state.json', async () => {
    writeFileSync(
      join(tmpHome, 'flusher-state.json'),
      JSON.stringify({ lastError: null, lastFlushAt: '2025-01-01T00:00:00.000Z', queueDepth: 7 }),
    );
    const { stdout } = await captureOutputAsync(async () => {
      await runStatus();
    });
    expect(stdout).toContain('2025-01-01T00:00:00.000Z');
  });

  it('shows last error from flusher-state.json', async () => {
    writeFileSync(
      join(tmpHome, 'flusher-state.json'),
      JSON.stringify({ lastError: 'Server error 503', lastFlushAt: null, queueDepth: 0 }),
    );
    const { stdout } = await captureOutputAsync(async () => {
      await runStatus();
    });
    expect(stdout).toContain('Server error 503');
  });
});
