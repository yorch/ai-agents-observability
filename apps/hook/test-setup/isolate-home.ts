// Test preload (bunfig.toml [test] preload): no test may touch the developer's real HOME.
//
// Why this exists: `install.test.ts` used to call `install(['--force', ...])` with
// no `--no-auto` and without setting HOME. The adapters resolve their config dirs
// from HOME, so every `bun test` run wired every detected agent into the
// developer's REAL ~/.claude/settings.json, ~/.codex/hooks.json and the opencode/pi
// plugin files — six more hook groups per run, silently, with the suite green.
// A convention ("remember to set HOME in your test") is what failed; this file is
// the enforcement.
//
// Two layers, both installed before any test module loads:
//   1. HOME and AIOT_HOME point at a fresh temp dir, and `os.homedir()` follows
//      HOME. Bun's own `os.homedir()` ignores a later HOME, and paths.ts, config.ts
//      and claude-projects.ts call it directly.
//   2. node:fs mutators throw if the target is under the REAL home's agent config
//      dirs. That is the backstop for any path that still resolves to the real
//      home (an absolute path, a cached value, a new module that reads the
//      passwd entry).
//
// `mock.module` is the only mechanism that works here: Bun's named imports from a
// builtin ignore monkey-patching of the module object.

import { mock } from 'bun:test';
import * as fsNs from 'node:fs';
import * as fsPromisesNs from 'node:fs/promises';
import * as osNs from 'node:os';
import { join, resolve } from 'node:path';

// Plain copies taken BEFORE mock.module: after it, the namespaces resolve to the
// mocks, and a mock that spreads its own namespace recurses.
const realFs = { ...fsNs };
const realFsPromises = { ...fsPromisesNs };
const realOs = { ...osNs };

/** Directories under a real home that tests must never write to. */
const PROTECTED = [
  '.claude',
  '.codex',
  '.config/opencode',
  '.pi',
  '.gemini',
  '.copilot',
  '.omp',
  '.oh-omp',
  '.aiot',
];

function realHomes(): string[] {
  const homes = new Set<string>();
  if (process.env.HOME) {
    homes.add(process.env.HOME);
  }
  try {
    homes.add(realOs.userInfo().homedir); // passwd entry: ignores HOME
  } catch {
    // no passwd entry (some containers): HOME alone has to do.
  }
  homes.add(realOs.homedir());
  return [...homes].filter((h) => h.length > 1).map((h) => resolve(h));
}

const protectedDirs = realHomes().flatMap((home) => PROTECTED.map((d) => join(home, d)));

function refuseIfProtected(target: unknown): void {
  if (typeof target !== 'string' && !(target instanceof URL) && !(target instanceof Uint8Array)) {
    return; // a file descriptor, or an unsupported shape the real fs will reject
  }
  const text =
    target instanceof URL
      ? target.pathname
      : String(target instanceof Uint8Array ? Buffer.from(target) : target);
  const abs = resolve(text);
  for (const dir of protectedDirs) {
    if (abs === dir || abs.startsWith(`${dir}/`)) {
      throw new Error(
        `[aiot test isolation] refusing to write under the real home: ${abs}. ` +
          'Tests must use a temp HOME (set up by test-setup/isolate-home.ts).',
      );
    }
  }
}

// Every mutator the hook code or its tests use, with how many leading args are paths.
const FS_MUTATORS: Record<string, number> = {
  appendFileSync: 1,
  chmodSync: 1,
  copyFileSync: 2,
  cpSync: 2,
  linkSync: 2,
  mkdirSync: 1,
  renameSync: 2,
  rmdirSync: 1,
  rmSync: 1,
  symlinkSync: 2,
  truncateSync: 1,
  unlinkSync: 1,
  utimesSync: 1,
  writeFileSync: 1,
};
const FS_PROMISES_MUTATORS: Record<string, number> = {
  appendFile: 1,
  chmod: 1,
  copyFile: 2,
  cp: 2,
  link: 2,
  mkdir: 1,
  rename: 2,
  rm: 1,
  rmdir: 1,
  symlink: 2,
  truncate: 1,
  unlink: 1,
  utimes: 1,
  writeFile: 1,
};

function guard<T extends Record<string, unknown>>(
  real: T,
  mutators: Record<string, number>,
  async = false,
): T {
  const out: Record<string, unknown> = { ...real };
  for (const [name, nPaths] of Object.entries(mutators)) {
    const fn = real[name];
    if (typeof fn !== 'function') {
      continue;
    }
    out[name] = (...args: unknown[]) => {
      try {
        for (let i = 0; i < nPaths; i++) {
          refuseIfProtected(args[i]);
        }
      } catch (err) {
        if (async) {
          return Promise.reject(err);
        }
        throw err;
      }
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as T;
}

// openSync is a mutator only when opened for writing.
function guardedOpenSync(...args: Parameters<typeof realFs.openSync>) {
  const flags = args[1];
  if (flags === undefined || flags === 'r' || flags === 'rs' || flags === 0) {
    return realFs.openSync(...args);
  }
  refuseIfProtected(args[0]);
  return realFs.openSync(...args);
}

const tmpHome = realFs.mkdtempSync(join(realOs.tmpdir(), 'aiot-test-home-'));
process.env.HOME = tmpHome;
process.env.AIOT_HOME = join(tmpHome, '.aiot');

const guardedFs = { ...guard(realFs, FS_MUTATORS), openSync: guardedOpenSync };
const guardedFsPromises = guard(realFsPromises, FS_PROMISES_MUTATORS, true);
const guardedOs = { ...realOs, homedir: () => process.env.HOME ?? tmpHome };

mock.module('node:fs', () => ({ ...guardedFs, default: guardedFs }));
mock.module('node:fs/promises', () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module('node:os', () => ({ ...guardedOs, default: guardedOs }));

process.on('exit', () => {
  try {
    realFs.rmSync(tmpHome, { force: true, recursive: true });
  } catch {
    // best effort: it is a temp dir
  }
});
