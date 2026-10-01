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
//   2. Writes under the REAL home's agent/service dirs throw (see guard.ts).
//
// WHAT IS GUARDED: node:fs mutators (sync, callback and promises forms, incl.
// write-mode open and createWriteStream) and Bun.write, for any path under the real
// home's protected dirs, symlinks resolved. WHAT IS NOT: `Bun.file().writer()`,
// bun:sqlite opening a database file, and child processes (`Bun.spawn` of an
// external tool). Those are covered only by layer 1 (HOME/AIOT_HOME are temp).
//
// bunfig.toml is read from the CWD only. Run from apps/hook (turbo and CI do), or
// from the repo root (the root bunfig points here too). From anywhere else this file
// does not load, and src/test-isolation.test.ts fails fast on the missing marker.
//
// `mock.module` is the only mechanism that works: Bun's named imports from a
// builtin ignore monkey-patching of the module object.

import { mock } from 'bun:test';
import * as fsNs from 'node:fs';
import * as fsPromisesNs from 'node:fs/promises';
import * as osNs from 'node:os';
import { join } from 'node:path';

import { opensForWrite, protectedDirsFor, refuseIfProtected } from './guard';

// Plain copies taken BEFORE mock.module: after it, the namespaces resolve to the
// mocks, and a mock that spreads its own namespace recurses.
const realFs = { ...fsNs };
const realFsPromises = { ...fsPromisesNs };
const realOs = { ...osNs };

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
  return [...homes].filter((h) => h.length > 1);
}

const realHomeList = realHomes();
const tmpHome = realFs.mkdtempSync(join(realOs.tmpdir(), 'aiot-test-home-'));
// A stand-in protected dir OUTSIDE tmpHome. Canary tests aim their probe writes
// here, so proving the guard never needs to touch the real home.
const fakeProtectedRoot = realFs.mkdtempSync(join(realOs.tmpdir(), 'aiot-test-protected-'));
const fakeProtectedDir = join(fakeProtectedRoot, '.claude');
realFs.mkdirSync(fakeProtectedDir, { recursive: true });

const protectedDirs = [...protectedDirsFor(realHomeList), fakeProtectedDir];
const check = (target: unknown) => refuseIfProtected(target, protectedDirs);

process.env.HOME = tmpHome;
process.env.AIOT_HOME = join(tmpHome, '.aiot');

// name → indexes of the path args that get written or removed. Sources that are
// only read (copyFile/cp/link source, a symlink's target) are not checked.
const MUTATORS: Record<string, number[]> = {
  appendFile: [0],
  chmod: [0],
  copyFile: [1],
  cp: [1],
  link: [1],
  mkdir: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  symlink: [1],
  truncate: [0],
  unlink: [0],
  utimes: [0],
  writeFile: [0],
};

function wrap(
  real: Record<string, unknown>,
  names: Record<string, number[]>,
  async: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...real };
  const guardCall =
    (paths: number[], fn: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      try {
        for (const i of paths) {
          check(args[i]);
        }
      } catch (err) {
        if (async) {
          return Promise.reject(err);
        }
        throw err;
      }
      return fn(...args);
    };
  for (const [name, paths] of Object.entries(names)) {
    for (const key of [name, `${name}Sync`]) {
      const fn = real[key];
      if (typeof fn === 'function' && (key === name || !async)) {
        out[key] = guardCall(paths, fn as (...a: unknown[]) => unknown);
      }
    }
  }
  // open/openSync only when opened for writing; createWriteStream always writes.
  for (const key of ['open', 'openSync']) {
    const fn = real[key];
    if (typeof fn === 'function') {
      out[key] = (...args: unknown[]) => {
        if (opensForWrite(args[1])) {
          return guardCall([0], fn as (...a: unknown[]) => unknown)(...args);
        }
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    }
  }
  if (typeof real.createWriteStream === 'function') {
    out.createWriteStream = guardCall([0], real.createWriteStream as (...a: unknown[]) => unknown);
  }
  return out;
}

const guardedFsPromises = wrap(realFsPromises, MUTATORS, true);
// `fs.promises` must be the guarded one, or it is a bypass around the named exports.
const guardedFs = { ...wrap(realFs, MUTATORS, false), promises: guardedFsPromises };

const guardedOs = { ...realOs, homedir: () => process.env.HOME ?? tmpHome };

mock.module('node:fs', () => ({ ...guardedFs, default: guardedFs }));
mock.module('node:fs/promises', () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module('node:os', () => ({ ...guardedOs, default: guardedOs }));

// Bun.write is a separate write path from node:fs.
const realBunWrite = Bun.write.bind(Bun);
Bun.write = ((dest: unknown, ...rest: unknown[]) => {
  try {
    check(dest);
  } catch (err) {
    return Promise.reject(err);
  }
  return (realBunWrite as (...a: unknown[]) => unknown)(dest, ...rest);
}) as typeof Bun.write;

// The marker canary tests assert FIRST, so a run without this preload fails with a
// clear message instead of probing the real home.
(globalThis as Record<string, unknown>).__AIOT_TEST_ISOLATION__ = {
  fakeProtectedDir,
  protectedDirs,
  realHome: realHomeList[realHomeList.length - 1],
  realHomes: realHomeList,
  tmpHome,
};

process.on('exit', () => {
  for (const dir of [tmpHome, fakeProtectedRoot]) {
    try {
      realFs.rmSync(dir, { force: true, recursive: true });
    } catch {
      // best effort: temp dirs
    }
  }
});
