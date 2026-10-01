// Proves test-setup/isolate-home.ts is live. If this file goes red, the preload is
// not loading (bunfig.toml moved, or the suite ran from a directory that skips it)
// and every other test is one `install()` call away from rewriting the developer's
// real agent configs again.

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { homeDir } from './lib/config-wire';
import { telemetryHome } from './lib/paths';

/** The passwd entry's home: unaffected by the HOME override the preload makes. */
const realHome = userInfo().homedir;
const PROBE = '__aiot_guard_probe__';

describe('test isolation preload', () => {
  it('points HOME, AIOT_HOME and os.homedir() at a temp dir, not the real home', () => {
    expect(process.env.HOME).not.toBe(realHome);
    expect(homeDir()).toBe(process.env.HOME as string);
    // Bun's own os.homedir() ignores HOME; the preload makes it follow it.
    expect(homedir()).toBe(process.env.HOME as string);
    expect(telemetryHome().startsWith(realHome)).toBe(false);
  });

  it('refuses writes under every protected dir of the real home', () => {
    for (const dir of [
      '.claude',
      '.codex',
      '.config/opencode',
      '.pi',
      '.gemini',
      '.copilot',
      '.omp',
      '.aiot',
    ]) {
      const target = join(realHome, dir, PROBE);
      expect(() => writeFileSync(target, 'x')).toThrow('aiot test isolation');
      expect(() => mkdirSync(target, { recursive: true })).toThrow('aiot test isolation');
      expect(() => rmSync(target, { force: true })).toThrow('aiot test isolation');
      expect(existsSync(target)).toBe(false);
    }
  });

  it('checks the destination of a rename as well as the source', () => {
    const inside = join(process.env.HOME as string, 'src-file');
    writeFileSync(inside, 'x');
    expect(() => renameSync(inside, join(realHome, '.claude', PROBE))).toThrow(
      'aiot test isolation',
    );
  });

  it('guards fs/promises too', async () => {
    const target = join(realHome, '.codex', PROBE);
    await expect(writeFile(target, 'x')).rejects.toThrow('aiot test isolation');
    await expect(mkdir(target, { recursive: true })).rejects.toThrow('aiot test isolation');
  });

  it('still allows writes under the temp HOME', () => {
    const target = join(process.env.HOME as string, '.claude', 'ok');
    mkdirSync(join(process.env.HOME as string, '.claude'), { recursive: true });
    writeFileSync(target, 'x');
    expect(existsSync(target)).toBe(true);
  });
});
