import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeCodeAdapter } from '../adapters/claude-code';
import { runInstall } from './install';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-install-test-'));
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
});

/** runInstall with the temp dir injected as homeDir (Bun's homedir() ignores $HOME). */
function install(args: string[], spawn: (cmd: readonly string[]) => { exitCode: number }): number {
  return runInstall(args, claudeCodeAdapter, spawn, tmpHome);
}

/** A spawn mock that records every call and returns exitCode 0. */
function recordingSpawn(): {
  fn: (cmd: readonly string[]) => { exitCode: number };
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (cmd: readonly string[]) => {
      calls.push([...cmd]);
      return { exitCode: 0 };
    },
  };
}

/** A spawn mock that fails every call with exitCode 1. */
function failingSpawn(_cmd: readonly string[]): { exitCode: number } {
  return { exitCode: 1 };
}

function captureOutput(fn: () => number): { stdout: string; stderr: string; exit: number } {
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
  let exit = 0;
  try {
    exit = fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return { exit, stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') };
}

// On macOS the darwin path runs; on Linux the linux path runs. The assertions
// below are written to pass on whichever platform the test host is, using
// process.platform to pick the expected paths.
const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
function launchAgentsDir(): string {
  return join(tmpHome, 'Library', 'LaunchAgents');
}
function systemdDir(): string {
  return join(tmpHome, '.config', 'systemd', 'user');
}

function flusherPath(): string {
  return isDarwin
    ? join(launchAgentsDir(), 'com.brnby.aiot.flusher.plist')
    : join(systemdDir(), 'aiot-flusher.service');
}
function shipperPath(): string {
  return isDarwin
    ? join(launchAgentsDir(), 'com.brnby.aiot.shipper.plist')
    : join(systemdDir(), 'aiot-shipper.service');
}

// ── uncompiled guard ──────────────────────────────────────────────────────────

describe('install — uncompiled guard', () => {
  // Under `bun test`, process.execPath is the Bun runtime, not the compiled
  // binary, so the guard fires. These tests exercise that path directly.

  it('refuses without --force and writes no service files', () => {
    const { stderr, exit } = captureOutput(() => install([], recordingSpawn().fn));
    expect(exit).toBe(1);
    expect(stderr).toContain('Refusing to install');
    expect(stderr).toContain('--force');
    expect(existsSync(flusherPath())).toBe(false);
    expect(existsSync(shipperPath())).toBe(false);
  });

  it('proceeds with --force', () => {
    const { exit } = captureOutput(() => install(['--force', '--no-start'], recordingSpawn().fn));
    expect(exit).toBe(0);
    expect(existsSync(flusherPath())).toBe(true);
    expect(existsSync(shipperPath())).toBe(true);
  });
});

// ── --no-start prints commands instead of running them ────────────────────────

describe('install --no-start', () => {
  it('writes files but does not load/enable services', () => {
    const rec = recordingSpawn();
    const { stdout, exit } = captureOutput(() => install(['--force', '--no-start'], rec.fn));
    expect(exit).toBe(0);
    expect(existsSync(flusherPath())).toBe(true);
    expect(existsSync(shipperPath())).toBe(true);
    // No spawn calls — nothing loaded/enabled.
    expect(rec.calls).toHaveLength(0);
    if (isDarwin) {
      expect(stdout).toContain('launchctl load');
    } else if (isLinux) {
      expect(stdout).toContain('systemctl --user enable --now');
    }
  });
});

// ── --start (default) loads/enables services ──────────────────────────────────

describe('install --start (default)', () => {
  it('loads/enables services via spawn', () => {
    const rec = recordingSpawn();
    const { exit } = captureOutput(() => install(['--force'], rec.fn));
    expect(exit).toBe(0);
    expect(rec.calls.length).toBeGreaterThan(0);
    if (isDarwin) {
      const loadCalls = rec.calls.filter((c) => c[0] === 'launchctl' && c[1] === 'load');
      expect(loadCalls).toHaveLength(2);
    } else if (isLinux) {
      const enableCalls = rec.calls.filter((c) => c[0] === 'systemctl' && c.includes('enable'));
      expect(enableCalls).toHaveLength(2);
      expect(rec.calls.some((c) => c.includes('daemon-reload'))).toBe(true);
    }
  });

  it('returns 1 when a load/enable call fails', () => {
    const { stderr, exit } = captureOutput(() => install(['--force'], failingSpawn));
    expect(exit).toBe(1);
    expect(stderr).toContain('Error');
    // Service files were still written.
    expect(existsSync(flusherPath())).toBe(true);
    expect(existsSync(shipperPath())).toBe(true);
  });
});

// ── upgrade: unloads existing services before overwriting ─────────────────────

describe('install — upgrade over existing service files', () => {
  it('unloads/disables existing services before rewriting', () => {
    // Pre-create the service files so the upgrade path detects them.
    if (isDarwin) {
      mkdirSync(launchAgentsDir(), { recursive: true });
      writeFileSync(flusherPath(), 'old', { mode: 0o644 });
      writeFileSync(shipperPath(), 'old', { mode: 0o644 });
    } else if (isLinux) {
      mkdirSync(systemdDir(), { recursive: true });
      writeFileSync(flusherPath(), 'old', { mode: 0o644 });
      writeFileSync(shipperPath(), 'old', { mode: 0o644 });
    }

    const rec = recordingSpawn();
    const { exit } = captureOutput(() => install(['--force'], rec.fn));
    expect(exit).toBe(0);
    if (isDarwin) {
      const unloadCalls = rec.calls.filter((c) => c[0] === 'launchctl' && c[1] === 'unload');
      expect(unloadCalls).toHaveLength(2);
    } else if (isLinux) {
      const disableCalls = rec.calls.filter((c) => c[0] === 'systemctl' && c.includes('disable'));
      expect(disableCalls).toHaveLength(2);
    }
    // Files were rewritten (not still "old").
    expect(readFileSync(flusherPath(), 'utf8')).not.toBe('old');
  });
});

// ── service file content ──────────────────────────────────────────────────────

const darwinOnly = isDarwin ? it : it.skip;
const linuxOnly = isLinux ? it : it.skip;

describe('install — service file content', () => {
  darwinOnly('writes a valid launchd plist on darwin', () => {
    captureOutput(() => install(['--force', '--no-start'], recordingSpawn().fn));
    const plist = readFileSync(flusherPath(), 'utf8');
    expect(plist).toContain('<?xml');
    expect(plist).toContain('com.brnby.aiot.flusher');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('flusher');
  });

  linuxOnly('writes a valid systemd unit on linux', () => {
    captureOutput(() => install(['--force', '--no-start'], recordingSpawn().fn));
    const unit = readFileSync(flusherPath(), 'utf8');
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=');
    expect(unit).toContain('Restart=always');
  });
});

// ── hook snippet is printed ───────────────────────────────────────────────────

describe('install — prints the agent hook snippet', () => {
  it('includes the settings hint and snippet', () => {
    const { stdout, exit } = captureOutput(() =>
      install(['--force', '--no-start'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    expect(stdout).toContain('settings.json');
  });
});
