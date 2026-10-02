// Unit tests for the guard function against SYNTHETIC protected dirs. Nothing here
// names the real home, and nothing is written outside a temp dir.

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  opensForWrite,
  PROTECTED_RELATIVE,
  protectedDirsFor,
  refuseIfProtected,
  refuseServiceManager,
} from './guard';

describe('refuseIfProtected', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiot-guard-unit-'));
  const home = join(root, 'home');
  const dirs = protectedDirsFor([home]);
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });

  it('covers the agent and service dirs for a home', () => {
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
      expect(PROTECTED_RELATIVE).toContain(rel);
      expect(dirs).toContain(join(home, rel));
    }
  });

  it('throws for the dir itself, files below it, URLs, buffers and BunFile-like objects', () => {
    const inside = join(home, '.claude', 'settings.json');
    expect(() => refuseIfProtected(join(home, '.claude'), dirs)).toThrow('aiot test isolation');
    expect(() => refuseIfProtected(inside, dirs)).toThrow('aiot test isolation');
    expect(() => refuseIfProtected(new URL(`file://${inside}`), dirs)).toThrow(
      'aiot test isolation',
    );
    expect(() => refuseIfProtected(Buffer.from(inside), dirs)).toThrow('aiot test isolation');
    expect(() => refuseIfProtected({ name: inside }, dirs)).toThrow('aiot test isolation');
    // `..` traversal into it, and a not-yet-existing nested path.
    expect(() => refuseIfProtected(join(home, 'x', '..', '.codex', 'a', 'b'), dirs)).toThrow(
      'aiot test isolation',
    );
  });

  it('does not throw for siblings, prefixes that only look similar, or non-paths', () => {
    expect(() => refuseIfProtected(join(home, '.claudeX', 'a'), dirs)).not.toThrow();
    expect(() => refuseIfProtected(join(home, 'Documents', 'a'), dirs)).not.toThrow();
    expect(() => refuseIfProtected(join(root, 'elsewhere', 'a'), dirs)).not.toThrow();
    expect(() => refuseIfProtected(3, dirs)).not.toThrow();
  });

  it('resolves symlinks, existing or via a not-yet-existing child', () => {
    const link = join(root, 'elsewhere', 'link');
    symlinkSync(join(home, '.claude'), link);
    expect(() => refuseIfProtected(link, dirs)).toThrow('aiot test isolation');
    expect(() => refuseIfProtected(join(link, 'new-file'), dirs)).toThrow('aiot test isolation');
  });

  it('reads the dir list live', () => {
    const extra = join(root, 'elsewhere');
    const live = [...dirs];
    expect(() => refuseIfProtected(join(extra, 'a'), live)).not.toThrow();
    live.push(extra);
    expect(() => refuseIfProtected(join(extra, 'a'), live)).toThrow('aiot test isolation');
    rmSync(root, { force: true, recursive: true });
  });
});

describe('opensForWrite', () => {
  it('treats only read modes as non-writing', () => {
    for (const f of [undefined, 'r', 'rs', 0]) {
      expect(opensForWrite(f)).toBe(false);
    }
    for (const f of ['w', 'a', 'r+', 'wx', 'a+', 65]) {
      expect(opensForWrite(f)).toBe(true);
    }
  });
});

describe('refuseServiceManager', () => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'aiot-guard-sm-'));

  it('refuses a bare systemctl/launchctl, as argv or as an options object', () => {
    expect(() => refuseServiceManager(['systemctl', '--user', 'is-active', 'x'], fakeDir)).toThrow(
      'REAL service manager',
    );
    expect(() => refuseServiceManager(['launchctl', 'list'], fakeDir)).toThrow('REAL service');
    expect(() => refuseServiceManager({ cmd: ['systemctl', 'status'] }, fakeDir)).toThrow(
      'REAL service',
    );
  });

  it('refuses an absolute path to the real binary', () => {
    expect(() => refuseServiceManager(['/usr/bin/systemctl', 'disable', 'x'], fakeDir)).toThrow(
      'REAL service',
    );
  });

  it('allows a test’s own fake under the fake dir, and every other command', () => {
    expect(() => refuseServiceManager([join(fakeDir, 'systemctl'), 'x'], fakeDir)).not.toThrow();
    expect(() => refuseServiceManager(['ls', '-1'], fakeDir)).not.toThrow();
    expect(() => refuseServiceManager([process.execPath, 'src/cli.ts'], fakeDir)).not.toThrow();
    expect(() => refuseServiceManager('systemctl', fakeDir)).not.toThrow(); // not an argv: not a spawn shape
  });
});
