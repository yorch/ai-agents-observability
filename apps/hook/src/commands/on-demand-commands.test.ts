import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeCodeAdapter } from '../adapters/claude-code';
import { readDrainStatus, readMode, recordDrainOk, writeMode } from '../lib/lease';
import { openQueue } from '../lib/queue';
import { runPurge } from './purge';
import { runStatus } from './status';

// These tests write and delete under HOME-relative agent config dirs. They are only
// safe under the preload in test-setup/isolate-home.ts, which `bun test` loads from
// apps/hook (or the repo root) and nowhere else. Refuse to run anything otherwise.
if (!(globalThis as { __AIOT_TEST_ISOLATION__?: unknown }).__AIOT_TEST_ISOLATION__) {
  throw new Error(
    'on-demand-commands.test.ts needs the test-isolation preload: run `bun test` from apps/hook',
  );
}

let tmpHome: string;
/** A per-test HOME that this file created and is the only thing it ever deletes. */
let fakeHome: string;

/** Every variable an adapter or the CLI resolves a config location from, under fakeHome. */
function sandboxEnv(): Record<string, string> {
  return {
    AIOT_CONFIG: join(tmpHome, 'config.json'),
    AIOT_HOME: tmpHome,
    CODEX_HOME: join(fakeHome, '.codex'),
    HOME: fakeHome,
    OMP_HOME: join(fakeHome, '.omp'),
    OPENCODE_DATA: join(fakeHome, '.local', 'share', 'opencode'),
    PI_HOME: join(fakeHome, '.pi'),
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    XDG_DATA_HOME: join(fakeHome, '.local', 'share'),
  };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-ondemand-cmd-'));
  fakeHome = join(tmpHome, 'home');
  mkdirSync(fakeHome);
  for (const [name, value] of Object.entries(sandboxEnv())) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  };
  process.stderr.write = (c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return chunks.join('');
}

/** A queue row as the hook writes it, aged `ageMs` into the past. */
function enqueueAged(ageMs: number): string {
  const ts = new Date(Date.now() - ageMs).toISOString();
  const q = openQueue();
  q.enqueue({ event_id: '0198f2c4-7a10-7b3e-9d41-5c2a6e1f0b77', payload_json: '{}', ts });
  writeMode(q.db, 'on-demand');
  q.close();
  return ts;
}

const STALE_HEARTBEAT = {
  lastError: null,
  lastFlushAt: null,
  lastHeartbeatAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  queueDepth: 1,
};

describe('status in on-demand mode', () => {
  it('does not raise the stale-heartbeat warning, and reports what matters instead', async () => {
    const ts = enqueueAged(3 * 3_600_000);
    writeFileSync(join(tmpHome, 'flusher-state.json'), JSON.stringify(STALE_HEARTBEAT));

    const out = await capture(() => runStatus());

    expect(out).not.toContain('WARNING');
    expect(out).not.toMatch(/heartbeat/i);
    expect(out).toMatch(/mode:\s+on-demand/);
    expect(out).toMatch(/queue depth:\s+1/);
    // A stuck queue stays visible: the age of the oldest undelivered row.
    expect(out).toMatch(/oldest queued:\s+3h old/);
    expect(out).toContain(ts);
    expect(out).toMatch(/last drain:\s+never/);
    expect(out).toMatch(/drain lease:\s+none/);
  });

  it('shows the time of the last clean drain', async () => {
    enqueueAged(1000);
    const q = openQueue();
    recordDrainOk(q.db, Date.parse('2026-09-30T12:00:00.000Z'));
    expect(readDrainStatus(q.db).lastDrainOkAt).toBe(Date.parse('2026-09-30T12:00:00.000Z'));
    q.close();

    const out = await capture(() => runStatus());
    expect(out).toContain('2026-09-30T12:00:00.000Z');
  });

  it('resident mode still raises the stale-heartbeat warning', async () => {
    const q = openQueue();
    q.enqueue({
      event_id: '0198f2c4-7a10-7b3e-9d41-5c2a6e1f0b78',
      payload_json: '{}',
      ts: new Date().toISOString(),
    });
    q.close();
    writeFileSync(join(tmpHome, 'flusher-state.json'), JSON.stringify(STALE_HEARTBEAT));

    const out = await capture(() => runStatus());
    expect(out).toContain('WARNING: flusher heartbeat');
    expect(out).toMatch(/mode:\s+resident/);
  });
});

describe('purge-local in on-demand mode', () => {
  it('removes the queue and its -wal/-shm, but keeps the install mode', async () => {
    enqueueAged(1000);
    const out = await capture(() => runPurge(['--yes']));

    expect(out).toContain('kept: install mode (on-demand)');
    // The recreated queue holds the mode and none of the old rows.
    const q = openQueue();
    expect(readDrainStatus(q.db).mode).toBe('on-demand');
    expect(q.db.query('SELECT COUNT(*) AS c FROM events_queue').get()).toEqual({ c: 0 });
    q.close();
  });

  it('leaves nothing behind for a resident install', async () => {
    const q = openQueue();
    q.close();
    await capture(() => runPurge(['--yes']));
    expect(existsSync(join(tmpHome, 'queue.db'))).toBe(false);
    expect(existsSync(join(tmpHome, 'queue.db-wal'))).toBe(false);
    expect(existsSync(join(tmpHome, 'queue.db-shm'))).toBe(false);
  });
});

const hookDir = join(import.meta.dir, '..', '..');

/**
 * Run the real CLI in a child with a fake `systemctl` first on PATH that only logs
 * its arguments (and exits `rc`). A child, because Bun resolves a bare executable
 * name against the PATH the process started with, so changing PATH in-process fakes
 * nothing. Every config location is pinned under fakeHome.
 */
function runAiot(args: string[], rc = 0) {
  const bin = join(tmpHome, 'fakebin');
  const log = join(tmpHome, 'systemctl.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${log}'\nexit ${rc}\n`, {
    mode: 0o755,
  });
  const run = Bun.spawnSync([process.execPath, 'src/cli.ts', ...args], {
    cwd: hookDir,
    env: { ...process.env, ...sandboxEnv(), PATH: `${bin}:${process.env.PATH}` },
  });
  return {
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    code: run.exitCode,
    out: run.stdout.toString() + run.stderr.toString(),
  };
}

const unitDir = () => join(fakeHome, '.config', 'systemd', 'user');

function writeUnits(): void {
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(join(unitDir(), 'aiot-flusher.service'), '[Service]\n');
  writeFileSync(join(unitDir(), 'aiot-shipper.service'), '[Service]\n');
}

describe('status: AIOT_TOKEN wording and service probes depend on the mode', () => {
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlbnYifQ.c2ln';
  afterEach(() => {
    delete process.env.AIOT_TOKEN;
  });

  it('on-demand: the drainer receives AIOT_TOKEN from the hook, so it is not "unseen"', async () => {
    enqueueAged(1000);
    process.env.AIOT_TOKEN = TOKEN;
    const out = await capture(() => runStatus());
    expect(out).toContain("the drainer receives it from the hook's environment");
    expect(out).not.toContain('do not see it');
    expect(out).not.toContain('eyJhbGci');
  });

  it.skipIf(process.platform !== 'linux')('on-demand: does not run systemctl at all', () => {
    enqueueAged(1000);
    const { calls, out } = runAiot(['status']);
    expect(out).toMatch(/mode:\s+on-demand/);
    expect(out).not.toMatch(/flusher:|shipper:/);
    expect(calls).toBe('');
  });

  it.skipIf(process.platform !== 'linux')('resident: still asks systemctl about both units', () => {
    const { calls, out } = runAiot(['status']);
    expect(out).toMatch(/flusher:\s+not running/);
    expect(calls).toContain('--user is-active aiot-flusher');
    expect(calls).toContain('--user is-active aiot-shipper');
  });

  it.skipIf(process.platform !== 'linux')(
    'on-demand: warns about leftover resident unit files, without spawning anything',
    () => {
      enqueueAged(1000);
      writeUnits();
      const { calls, out } = runAiot(['status']);
      expect(out).toContain(
        'warning: resident service files still present — run `aiot install --mode on-demand` again or `aiot uninstall`',
      );
      expect(calls).toBe('');
    },
  );

  it.skipIf(process.platform !== 'linux')('on-demand: no warning when no unit files exist', () => {
    enqueueAged(1000);
    const { out } = runAiot(['status']);
    expect(out).not.toContain('resident service files');
  });
});

describe.skipIf(process.platform !== 'linux')(
  'uninstall output says what actually happened',
  () => {
    function wireClaudeOnly(): string {
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      claudeCodeAdapter.installConfig().apply?.('/usr/local/bin/aiot');
      return join(fakeHome, '.claude', 'settings.json');
    }

    it('on-demand with only Claude Code wired: lists just that agent, no "Services uninstalled"', () => {
      enqueueAged(1000);
      const settings = wireClaudeOnly();
      expect(readFileSync(settings, 'utf8')).toContain('aiot');

      const { calls, code, out } = runAiot(['uninstall']);

      expect(code).toBe(0);
      expect(out).toContain('removed hooks: Claude Code');
      expect(out.match(/removed hooks:/g)).toHaveLength(1);
      expect(out).toContain('No services to remove (on-demand mode installs none)');
      expect(out).toContain('Install mode reset to resident.');
      expect(out).not.toContain('Services uninstalled');
      expect(calls).toBe('');
      expect(readFileSync(settings, 'utf8')).not.toContain('aiot');
      const q = openQueue();
      expect(readMode(q.db)).toBe('resident');
      q.close();
    });

    it('says so when no agent had hooks wired', () => {
      const { code, out } = runAiot(['uninstall']);
      expect(code).toBe(0);
      expect(out).not.toContain('removed hooks:');
      expect(out).toContain('No aiot hooks found in auto-wired agent configs.');
      expect(out).toContain('No services to remove. Local data was not removed.');
      expect(out).not.toContain('Install mode reset');
    });

    it('resident: reports the unit files it removed', () => {
      writeUnits();

      const { calls, out } = runAiot(['uninstall']);

      expect(out).toContain('Services removed. Local data was not removed.');
      expect(out).not.toContain('No services to remove');
      expect(calls).toContain('--user disable --now aiot-flusher.service');
      expect(existsSync(join(unitDir(), 'aiot-flusher.service'))).toBe(false);
    });

    it('resident: does not claim the services were removed cleanly when systemctl failed', () => {
      writeUnits();

      const { out } = runAiot(['uninstall'], 3);

      expect(out).toContain(
        'Service files removed (could not stop the running service: aiot-flusher.service, aiot-shipper.service)',
      );
      expect(out).not.toContain('Services removed.');
      expect(existsSync(join(unitDir(), 'aiot-flusher.service'))).toBe(false);
    });

    it('a corrupt Claude settings.json is a failure: named, not "nothing wired", exit 1', () => {
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{ "hooks": ');

      const { code, out } = runAiot(['uninstall']);

      expect(code).toBe(1);
      expect(out).toContain('Could not remove aiot hooks from: Claude Code (see errors above)');
      expect(out).toContain('Error removing Claude Code hooks');
      expect(out).not.toContain('No aiot hooks found');
      expect(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf8')).toBe('{ "hooks": ');
    });

    it('a Codex wrapper plus a corrupt hooks.json fails and names Codex', () => {
      const codex = join(fakeHome, '.codex');
      mkdirSync(codex, { recursive: true });
      writeFileSync(join(codex, 'aiot-notify.sh'), '#!/bin/sh\n');
      writeFileSync(join(codex, 'hooks.json'), '{ "hooks": ');

      const { code, out } = runAiot(['uninstall']);

      expect(code).toBe(1);
      expect(out).toContain('Could not remove aiot hooks from: Codex CLI (see errors above)');
      expect(out).not.toContain('No aiot hooks found');
    });

    it('reports both an agent it could not clean and one it did', () => {
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{ "hooks": ');
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(join(fakeHome, '.codex', 'aiot-notify.sh'), '#!/bin/sh\n');

      const { code, out } = runAiot(['uninstall']);

      expect(code).toBe(1);
      expect(out).toContain('removed hooks: Codex CLI');
      expect(out).toContain('Could not remove aiot hooks from: Claude Code (see errors above)');
    });
  },
);
