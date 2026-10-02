// Proves test-setup/isolate-home.ts is live. If this file goes red, the preload is
// not loading and every other test is one `install()` call away from rewriting the
// developer's real agent configs again.
//
// bunfig.toml is read from the CWD only, so `bun test` from anywhere but apps/hook
// (or the repo root, whose bunfig points at the same preload) runs UNGUARDED. The
// check below therefore comes before any write, and every probe write targets the
// fake protected dir the preload exports, never the real home.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFile,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, writeFile as writeFileP } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { homeDir } from './lib/config-wire';
import { telemetryHome } from './lib/paths';

type Isolation = {
  fakeProtectedDir: string;
  protectedDirs: string[];
  realHome: string;
  realHomes: string[];
  tmpHome: string;
};
const iso = (globalThis as { __AIOT_TEST_ISOLATION__?: Isolation }).__AIOT_TEST_ISOLATION__;
if (!iso) {
  throw new Error(
    'Test isolation preload not loaded: run `bun test` from apps/hook (or the repo root). ' +
      'bunfig.toml is read from the CWD only; running from another directory is UNGUARDED ' +
      'and tests could write to your real home. Nothing was written.',
  );
}

const PROBE = '__aiot_guard_probe__';
const REFUSED = 'aiot test isolation';
const fake = iso.fakeProtectedDir;

describe('test isolation preload', () => {
  it('points HOME, AIOT_HOME and os.homedir() at a temp dir, not the real home', () => {
    for (const realHome of iso.realHomes) {
      expect(process.env.HOME).not.toBe(realHome);
      expect(telemetryHome().startsWith(realHome)).toBe(false);
    }
    expect(homeDir()).toBe(process.env.HOME as string);
    // Bun's own os.homedir() ignores HOME; the preload makes it follow it.
    expect(homedir()).toBe(process.env.HOME as string);
  });

  it('protects the real home, every agent and service dir (checked without writing)', () => {
    for (const rel of [
      '.claude',
      '.codex',
      '.config/opencode',
      '.config/systemd',
      '.pi',
      '.gemini',
      '.copilot',
      '.omp',
      '.aiot',
      'Library/LaunchAgents',
    ]) {
      for (const home of iso.realHomes) {
        expect(iso.protectedDirs).toContain(join(home, rel));
      }
    }
  });

  it('refuses to run the real systemctl/launchctl in-process', () => {
    expect(() => Bun.spawnSync(['systemctl', '--user', 'is-active', '__aiot_probe__'])).toThrow(
      'REAL service manager',
    );
    expect(() => Bun.spawn(['launchctl', 'list', '__aiot_probe__'])).toThrow(
      'REAL service manager',
    );
    expect(() => Bun.spawnSync({ cmd: ['systemctl', 'status'] })).toThrow('REAL service manager');
    // Ordinary commands are untouched.
    expect(Bun.spawnSync([process.execPath, '--version']).exitCode).toBe(0);
  });

  it('refuses every guarded write API under a protected dir', async () => {
    const target = join(fake, PROBE);
    expect(() => writeFileSync(target, 'x')).toThrow(REFUSED);
    expect(() => appendFileSync(target, 'x')).toThrow(REFUSED);
    expect(() => mkdirSync(target, { recursive: true })).toThrow(REFUSED);
    expect(() => rmSync(target, { force: true })).toThrow(REFUSED);
    expect(() => openSync(target, 'w')).toThrow(REFUSED);
    expect(() => createWriteStream(target)).toThrow(REFUSED);
    expect(() => writeFile(target, 'x', () => {})).toThrow(REFUSED);
    expect(() => fs.mkdir(target, () => {})).toThrow(REFUSED);
    await expect(fs.promises.writeFile(target, 'x')).rejects.toThrow(REFUSED);
    await expect(writeFileP(target, 'x')).rejects.toThrow(REFUSED);
    await expect(mkdir(target, { recursive: true })).rejects.toThrow(REFUSED);
    await expect(open(target, 'w')).rejects.toThrow(REFUSED);
    await expect(Bun.write(target, 'x')).rejects.toThrow(REFUSED);
    await expect(Bun.write(Bun.file(target), 'x')).rejects.toThrow(REFUSED);
    expect(existsSync(target)).toBe(false);
  });

  it('checks the destination of a rename as well as the source', () => {
    const inside = join(process.env.HOME as string, 'src-file');
    writeFileSync(inside, 'x');
    expect(() => renameSync(inside, join(fake, PROBE))).toThrow(REFUSED);
    expect(existsSync(inside)).toBe(true);
  });

  it('is not bypassed through a symlink into a protected dir', () => {
    const link = join(process.env.HOME as string, 'sneaky');
    symlinkSync(fake, link);
    expect(() => writeFileSync(join(link, PROBE), 'x')).toThrow(REFUSED);
    expect(existsSync(join(fake, PROBE))).toBe(false);
  });

  it('allows opening a protected file for reading', () => {
    // The fake dir is protected for writes only; reads must keep working (adapters
    // read the real settings before deciding what to write).
    expect(() => readFileSync(join(fake, PROBE))).toThrow('ENOENT');
  });

  it('still allows writes under the temp HOME', () => {
    const target = join(process.env.HOME as string, '.claude', 'ok');
    mkdirSync(join(process.env.HOME as string, '.claude'), { recursive: true });
    writeFileSync(target, 'x');
    expect(existsSync(target)).toBe(true);
  });
});
