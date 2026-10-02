import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as nodeCrypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCliConfig } from './config';
import { readJsonFile, writeFileAtomic, writeJsonFile, writeTextFile } from './config-wire';

let root: string;

beforeEach(() => {
  // realpath: macOS's tmpdir sits under a /var symlink, which would make every path "linked".
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aiot-config-wire-')));
});

afterEach(() => {
  // Only the per-test directory this file created.
  rmSync(root, { force: true, recursive: true });
});

const isLink = (p: string) => lstatSync(p).isSymbolicLink();
const strays = (dir: string) => readdirSync(dir).filter((n) => n.includes('.aiot-tmp'));

describe('atomic writes to symlinked config files', () => {
  it('writes through a relative symlink: the link survives, the target is updated', () => {
    const dotfiles = join(root, 'dotfiles');
    const claude = join(root, 'home', '.claude');
    mkdirSync(dotfiles, { recursive: true });
    mkdirSync(claude, { recursive: true });
    const target = join(dotfiles, 'claude-settings.json');
    const link = join(claude, 'settings.json');
    writeFileSync(target, '{"theme":"dark"}\n');
    symlinkSync('../../dotfiles/claude-settings.json', link);

    writeJsonFile(link, { hooks: { Stop: [] }, theme: 'dark' });

    expect(isLink(link)).toBe(true);
    expect(readlinkSync(link)).toBe('../../dotfiles/claude-settings.json');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      hooks: { Stop: [] },
      theme: 'dark',
    });
    expect(isLink(target)).toBe(false);
    // Temp files live beside the REAL target, and none are left behind anywhere.
    expect(strays(dotfiles)).toEqual([]);
    expect(strays(claude)).toEqual([]);
  });

  it('writes through an absolute symlink (writeTextFile)', () => {
    const target = join(root, 'real.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'old');
    symlinkSync(target, link);

    writeTextFile(link, 'new');

    expect(isLink(link)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  it('follows a chain of links and creates a dangling link target', () => {
    const real = join(root, 'store', 'real.json');
    mkdirSync(join(root, 'store'));
    symlinkSync(real, join(root, 'hop2.json')); // dangling: real.json does not exist yet
    symlinkSync(join(root, 'hop2.json'), join(root, 'hop1.json'));

    writeJsonFile(join(root, 'hop1.json'), { a: 1 });

    expect(isLink(join(root, 'hop1.json'))).toBe(true);
    expect(isLink(join(root, 'hop2.json'))).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ a: 1 });
  });

  it('a plain file still works, creating parent directories', () => {
    const p = join(root, 'nested', 'dir', 'settings.json');
    writeJsonFile(p, { ok: true });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ok: true });
    expect(strays(join(root, 'nested', 'dir'))).toEqual([]);
  });

  it('aiot’s own config.json can be a symlink too, and stays 0600', () => {
    const cfgDir = join(root, 'xdg', 'aiot');
    const store = join(root, 'dotfiles', 'aiot-config.json');
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(join(root, 'dotfiles'));
    writeFileSync(store, '{}\n');
    symlinkSync(store, join(cfgDir, 'config.json'));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    try {
      writeCliConfig({ web_url: 'https://observability.example.com' });
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prev;
      }
    }
    expect(isLink(join(cfgDir, 'config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({
      web_url: 'https://observability.example.com',
    });
    expect(lstatSync(store).mode & 0o777).toBe(0o600);
  });

  it('removes its temp file when the write fails', () => {
    // A directory where the file should be: rename over it fails after the temp was written.
    const p = join(root, 'settings.json');
    mkdirSync(p);
    expect(() => writeJsonFile(p, { a: 1 })).toThrow();
    expect(strays(root)).toEqual([]);
  });
});

describe('concurrent applies', () => {
  it('two real processes applying at once neither fail nor lose the user’s hooks', async () => {
    const home = join(root, 'home');
    const settings = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const userGroup = { hooks: [{ command: '/usr/bin/notify-send', type: 'command' }] };
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { Notification: [userGroup], Stop: [userGroup] },
        model: 'opus',
        permissions: { allow: Array.from({ length: 400 }, (_, i) => `Bash(cmd-${i}:*)`) },
      }),
    );

    const adapterUrl = join(import.meta.dir, '..', 'adapters', 'claude-code');
    // A child process per applier: one process cannot race itself.
    const script = `
      const { claudeCodeAdapter } = await import(${JSON.stringify(adapterUrl)});
      const { apply } = claudeCodeAdapter.installConfig();
      let failures = 0;
      for (let i = 0; i < 150; i++) {
        if (apply('/usr/local/bin/aiot') === null) failures++;
      }
      process.exit(failures === 0 ? 0 : 3);
    `;
    const spawn = () =>
      Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, AIOT_HOME: join(home, '.aiot'), HOME: home },
        stderr: 'pipe',
        stdout: 'pipe',
      });
    const children = [spawn(), spawn()];
    const codes = await Promise.all(children.map((c) => c.exited));
    const stderr = await Promise.all(children.map((c) => new Response(c.stderr).text()));

    expect({ codes, stderr: stderr.join('') }).toEqual({
      codes: [0, 0],
      stderr: ['', ''].join(''),
    });
    const final = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      model: string;
      permissions: { allow: string[] };
    };
    expect(final.model).toBe('opus');
    expect(final.permissions.allow).toHaveLength(400);
    // The user's own hooks survived exactly once, and ours were added exactly once.
    for (const event of ['Notification', 'Stop']) {
      const groups = final.hooks[event] ?? [];
      expect(groups.filter((g) => g.hooks[0]?.command === '/usr/bin/notify-send')).toHaveLength(1);
      expect(groups.filter((g) => g.hooks[0]?.command === '/usr/local/bin/aiot')).toHaveLength(1);
    }
    expect(strays(join(home, '.claude'))).toEqual([]);
  });
});

describe('symlink resolution matches the kernel', () => {
  // ~/.claude -> dotfiles/claude, and inside it settings.json -> ../real-settings.json.
  // The kernel resolves that second link from dotfiles/claude (the link's REAL
  // directory), i.e. to dotfiles/real-settings.json. Resolving it lexically from
  // home/.claude wrote a stray home/real-settings.json and reported success.
  function layout() {
    const home = join(root, 'home');
    const dotfiles = join(root, 'dotfiles');
    mkdirSync(home);
    mkdirSync(join(dotfiles, 'claude'), { recursive: true });
    symlinkSync('../dotfiles/claude', join(home, '.claude'));
    symlinkSync('../real-settings.json', join(dotfiles, 'claude', 'settings.json'));
    return { dotfiles, home, settings: join(home, '.claude', 'settings.json') };
  }

  it('writes to the real file when the link’s directory is itself a symlink', () => {
    const { dotfiles, home, settings } = layout();
    writeFileSync(join(dotfiles, 'real-settings.json'), '{"old":true}\n');

    writeJsonFile(settings, { hooks: {} });

    expect(JSON.parse(readFileSync(join(dotfiles, 'real-settings.json'), 'utf8'))).toEqual({
      hooks: {},
    });
    expect(existsSync(join(home, 'real-settings.json'))).toBe(false);
    expect(isLink(join(dotfiles, 'claude', 'settings.json'))).toBe(true);
    expect(isLink(join(home, '.claude'))).toBe(true);
  });

  it('does the same when the final target does not exist yet (dangling link)', () => {
    const { dotfiles, home, settings } = layout();

    writeJsonFile(settings, { hooks: {} });

    expect(JSON.parse(readFileSync(join(dotfiles, 'real-settings.json'), 'utf8'))).toEqual({
      hooks: {},
    });
    expect(existsSync(join(home, 'real-settings.json'))).toBe(false);
    expect(isLink(join(dotfiles, 'claude', 'settings.json'))).toBe(true);
  });
});

describe('file mode', () => {
  const umask = process.umask(0o002);
  afterEach(() => {
    process.umask(umask);
  });

  it('a 0600 file stays 0600, plain or behind a link (the real file keeps its mode)', () => {
    process.umask(0o002);
    const plain = join(root, 'plain.json');
    const real = join(root, 'real.json');
    const link = join(root, 'link.json');
    writeFileSync(plain, '{}');
    writeFileSync(real, '{}');
    chmodSync(plain, 0o600);
    chmodSync(real, 0o600);
    symlinkSync(real, link);

    writeJsonFile(plain, { a: 1 });
    writeJsonFile(link, { a: 1 });

    expect(lstatSync(plain).mode & 0o7777).toBe(0o600);
    expect(lstatSync(real).mode & 0o7777).toBe(0o600);
  });

  it('keeps group bits the umask would mask, and a new file gets the umask default', () => {
    process.umask(0o022);
    const p = join(root, 'shared.json');
    writeFileSync(p, '{}');
    chmodSync(p, 0o664);
    writeJsonFile(p, { a: 1 });
    expect(lstatSync(p).mode & 0o7777).toBe(0o664);

    const fresh = join(root, 'fresh.json');
    writeJsonFile(fresh, { a: 1 });
    expect(lstatSync(fresh).mode & 0o7777).toBe(0o644);
  });

  it('an explicit mode wins over the existing file’s', () => {
    const p = join(root, 'secret.json');
    writeFileSync(p, '{}');
    chmodSync(p, 0o644);
    writeFileAtomic(p, '{}', 0o600);
    expect(lstatSync(p).mode & 0o7777).toBe(0o600);
  });
});

describe('a symlink into a read-only location', () => {
  it('fails with a message that names the link and the real target, and leaves no temp', () => {
    const store = join(root, 'store');
    mkdirSync(store);
    const real = join(store, 'settings.json');
    writeFileSync(real, '{}');
    const link = join(root, 'settings.json');
    symlinkSync(real, link);
    chmodSync(store, 0o555); // like /nix/store: the directory cannot take a new file
    try {
      expect(() => writeJsonFile(link, { a: 1 })).toThrow(
        `${link} is a symlink into a read-only location (${realpathSync(real)}); aiot cannot update it`,
      );
    } finally {
      chmodSync(store, 0o755);
    }
    expect(strays(store)).toEqual([]);
    expect(readFileSync(real, 'utf8')).toBe('{}');
  });

  it('a plain unwritable directory keeps its original error', () => {
    const dir = join(root, 'ro');
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    try {
      expect(() => writeJsonFile(join(dir, 'settings.json'), {})).toThrow(/EACCES|permission/i);
      expect(() => writeJsonFile(join(dir, 'settings.json'), {})).not.toThrow(/symlink/);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('stale temp files from a killed writer', () => {
  const DAY = 24 * 3600;
  const deadPid = () => Bun.spawnSync(['true']).pid;
  function temp(name: string, ageSeconds: number): string {
    const p = join(root, name);
    writeFileSync(p, 'half');
    const t = Date.now() / 1000 - ageSeconds;
    utimesSync(p, t, t);
    return p;
  }

  it('removes old temps of dead writers and nothing else', () => {
    const target = join(root, 'settings.json');
    writeFileSync(target, '{}');
    const dead = deadPid();
    const stale = temp(`settings.json.aiot-tmp.${dead}.deadbeef`, DAY);
    const alive = temp(`settings.json.aiot-tmp.${process.pid}.deadbeef`, DAY);
    const recent = temp(`settings.json.aiot-tmp.${dead}.cafebabe`, 60);
    const legacy = temp('settings.json.aiot-tmp', DAY);
    const other = temp(`other.json.aiot-tmp.${dead}.deadbeef`, DAY);
    const odd = temp(`settings.json.aiot-tmp.${dead}.zzzz`, DAY);
    const outside = join(root, 'precious.txt');
    writeFileSync(outside, 'keep');
    utimesSync(outside, Date.now() / 1000 - DAY, Date.now() / 1000 - DAY); // old, so only the lstat check saves the link
    const linkName = join(root, `settings.json.aiot-tmp.${dead}.0badf00d`);
    symlinkSync(outside, linkName);

    writeJsonFile(target, { a: 1 });

    expect(existsSync(stale)).toBe(false);
    for (const kept of [alive, recent, legacy, other, odd, outside]) {
      expect(existsSync(kept)).toBe(true);
    }
    expect(isLink(linkName)).toBe(true); // a link by that name is never followed or removed
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });
});

describe('concurrent read-modify-write cycles', () => {
  it('can still lose an update: the atomic rename gives no mutual exclusion', () => {
    // Pinned on purpose, so the documented limitation stays honest. Both writers
    // read the same file, each adds its own entry, each renames a COMPLETE file:
    // nothing is corrupted, but the second rename drops the first writer's entry.
    const p = join(root, 'settings.json');
    writeJsonFile(p, { hooks: [] });
    const a = readJsonFile<{ hooks: string[] }>(p);
    const b = readJsonFile<{ hooks: string[] }>(p);
    writeJsonFile(p, { hooks: [...(a?.hooks ?? []), 'from-aiot'] });
    writeJsonFile(p, { hooks: [...(b?.hooks ?? []), 'from-the-agent'] });
    expect(readJsonFile<{ hooks: string[] }>(p)).toEqual({ hooks: ['from-the-agent'] });
  });
});

describe('the temp file is created with its final mode and O_EXCL', () => {
  // writeFileSync's options are what decide the creation mode, so they are asserted
  // directly: a write-then-chmod would leave the contents (settings.json can hold `env`
  // and `apiKeyHelper`) readable by anyone for the length of the write.
  function tempWriteOptions(run: () => void): Record<string, unknown> {
    const real = fs.writeFileSync;
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((...args: unknown[]) =>
      (real as (...a: unknown[]) => unknown)(...args)) as never);
    try {
      run();
      const call = spy.mock.calls.find(([path]) => String(path).includes('.aiot-tmp.'));
      expect(call).toBeDefined();
      return (call?.[2] ?? {}) as Record<string, unknown>;
    } finally {
      spy.mockRestore();
    }
  }

  it('a 0600 target gets a 0600, wx temp', () => {
    const target = join(root, 'settings.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o600);
    const opts = tempWriteOptions(() => writeFileAtomic(target, '{"env":{}}'));
    expect(opts).toMatchObject({ flag: 'wx', mode: 0o600 });
    expect(lstatSync(target).mode & 0o7777).toBe(0o600);
  });

  it('an explicit mode wins, and a new file gets the umask default (no mode passed)', () => {
    const explicit = join(root, 'explicit.json');
    writeFileSync(explicit, '{}');
    chmodSync(explicit, 0o644);
    expect(tempWriteOptions(() => writeFileAtomic(explicit, '{}', 0o640))).toMatchObject({
      flag: 'wx',
      mode: 0o640,
    });

    const fresh = tempWriteOptions(() => writeFileAtomic(join(root, 'fresh.json'), '{}'));
    expect(fresh.flag).toBe('wx');
    expect(fresh.mode).toBeUndefined();
  });

  it('a link planted at the temp name is refused, not followed or overwritten', () => {
    const target = join(root, 'settings.json');
    writeFileSync(target, '{"keep":true}');
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'precious');
    // Make the "random" suffix predictable and plant a link at exactly that name.
    const randomSpy = spyOn(nodeCrypto, 'randomBytes').mockImplementation((() =>
      Buffer.from('deadbeef', 'hex')) as never);
    const planted = `${target}.aiot-tmp.${process.pid}.deadbeef`;
    symlinkSync(victim, planted);
    try {
      expect(() => writeFileAtomic(target, '{"new":true}')).toThrow(/EEXIST/);
    } finally {
      randomSpy.mockRestore();
    }
    expect(readFileSync(victim, 'utf8')).toBe('precious'); // never written through the link
    expect(readFileSync(target, 'utf8')).toBe('{"keep":true}'); // target unchanged
    expect(() => lstatSync(planted)).toThrow(/ENOENT/); // the failure path removed the link itself
    expect(existsSync(victim)).toBe(true); // ...and not what it pointed at
  });
});

describe('a symlinked parent directory that cannot take the temp file', () => {
  it('a plain file under a symlinked PARENT names the real directory that is not writable', () => {
    const ro = join(root, 'ro');
    mkdirSync(ro);
    symlinkSync(ro, join(root, 'via'));
    chmodSync(ro, 0o555);
    try {
      const attempt = () => writeJsonFile(join(root, 'via', 'settings.json'), {});
      expect(attempt).toThrow(`${join(root, 'via', 'settings.json')}: ${ro} is not writable`);
      expect(attempt).not.toThrow(/aiot-tmp/); // not a temp name the user has never seen
      expect(attempt).not.toThrow(/is a symlink into/); // the FILE is not the link
    } finally {
      chmodSync(ro, 0o755);
    }
  });
});
