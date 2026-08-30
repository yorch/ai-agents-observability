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
async function install(
  args: string[],
  spawn: (cmd: readonly string[]) => { exitCode: number },
): Promise<number> {
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

async function captureOutput(
  fn: () => Promise<number> | number,
): Promise<{ stdout: string; stderr: string; exit: number }> {
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
    exit = await fn();
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

  it('refuses without --force and writes no service files', async () => {
    const { stderr, exit } = await captureOutput(() => install([], recordingSpawn().fn));
    expect(exit).toBe(1);
    expect(stderr).toContain('Refusing to install');
    expect(stderr).toContain('--force');
    expect(existsSync(flusherPath())).toBe(false);
    expect(existsSync(shipperPath())).toBe(false);
  });

  it('proceeds with --force', async () => {
    const { exit } = await captureOutput(() =>
      install(['--force', '--no-start'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    expect(existsSync(flusherPath())).toBe(true);
    expect(existsSync(shipperPath())).toBe(true);
  });
});

// ── --no-start prints commands instead of running them ────────────────────────

describe('install --no-start', () => {
  it('writes files but does not load/enable services', async () => {
    const rec = recordingSpawn();
    const { stdout, exit } = await captureOutput(() => install(['--force', '--no-start'], rec.fn));
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
  it('loads/enables services via spawn', async () => {
    const rec = recordingSpawn();
    const { exit } = await captureOutput(() => install(['--force'], rec.fn));
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

  it('returns 1 when a load/enable call fails', async () => {
    const { stderr, exit } = await captureOutput(() => install(['--force'], failingSpawn));
    expect(exit).toBe(1);
    expect(stderr).toContain('Error');
    // Service files were still written.
    expect(existsSync(flusherPath())).toBe(true);
    expect(existsSync(shipperPath())).toBe(true);
  });
});

// ── upgrade: unloads existing services before overwriting ─────────────────────

describe('install — upgrade over existing service files', () => {
  it('unloads/disables existing services before rewriting', async () => {
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
    const { exit } = await captureOutput(() => install(['--force'], rec.fn));
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
  darwinOnly('writes a valid launchd plist on darwin', async () => {
    await captureOutput(() => install(['--force', '--no-start'], recordingSpawn().fn));
    const plist = readFileSync(flusherPath(), 'utf8');
    expect(plist).toContain('<?xml');
    expect(plist).toContain('com.brnby.aiot.flusher');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('flusher');
  });

  linuxOnly('writes a valid systemd unit on linux', async () => {
    await captureOutput(() => install(['--force', '--no-start'], recordingSpawn().fn));
    const unit = readFileSync(flusherPath(), 'utf8');
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=');
    expect(unit).toContain('Restart=always');
  });
});

// ── hook snippet is printed ───────────────────────────────────────────────────

describe('install — prints the agent hook snippet', () => {
  it('includes the settings hint and snippet', async () => {
    const { stdout, exit } = await captureOutput(() =>
      install(['--force', '--no-start', '--no-auto'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    expect(stdout).toContain('settings.json');
  });
});

// ── install flags: --dry-run, --yes, --agent, --no-auto ───────────────────────
//
// These tests set process.env.HOME to the temp dir so adapter detect()/apply()
// (which read HOME via lib/config-wire) operate against the sandboxed home.

describe('install --dry-run', () => {
  it('returns 0 and writes no service files', async () => {
    const { exit } = await captureOutput(() =>
      install(['--force', '--dry-run'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    // No service files written in dry-run mode.
    expect(existsSync(flusherPath())).toBe(false);
    expect(existsSync(shipperPath())).toBe(false);
  });

  it('prints what it would write', async () => {
    const { stdout, exit } = await captureOutput(() =>
      install(['--force', '--dry-run', '--no-start'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toContain(flusherPath());
  });
});

describe('install --yes', () => {
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Make Claude Code detectable so --yes has something to auto-wire.
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('skips the interactive prompt and auto-wires all detected agents', async () => {
    const { stdout, exit } = await captureOutput(() =>
      install(['--force', '--yes', '--no-start'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    // Claude Code was detected and wired without prompting.
    expect(stdout).toContain('Wired Claude Code');
    // The settings file should now contain our hooks.
    const settings = JSON.parse(readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);
  });
});

describe('install --agent <name>', () => {
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Make both Claude Code and Gemini detectable.
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    mkdirSync(join(tmpHome, '.gemini'), { recursive: true });
  });

  afterEach(() => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('wires only the specified agent, not all detected ones', async () => {
    const { stdout, exit } = await captureOutput(() =>
      install(['--force', '--agent', 'claude-code', '--no-start'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    expect(stdout).toContain('Wired Claude Code');
    // Gemini was also detectable but should NOT have been wired.
    expect(stdout).not.toContain('Wired Gemini');
    // Claude Code settings were written; Gemini's were not.
    expect(existsSync(join(tmpHome, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(tmpHome, '.gemini', 'settings.json'))).toBe(false);
  });
});

describe('install --no-auto', () => {
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Make Claude Code detectable — --no-auto must still skip wiring.
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('skips auto-wiring and only prints snippets', async () => {
    const { stdout, exit } = await captureOutput(() =>
      install(['--force', '--no-auto', '--no-start'], recordingSpawn().fn),
    );
    expect(exit).toBe(0);
    // No agent was wired.
    expect(stdout).not.toContain('Wired Claude Code');
    // Snippets are printed instead.
    expect(stdout).toContain('settings.json');
    // No settings file was written.
    expect(existsSync(join(tmpHome, '.claude', 'settings.json'))).toBe(false);
  });
});
