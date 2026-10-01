// The write guard behind isolate-home.ts, kept free of side effects so it can be
// unit-tested (guard.test.ts) against a synthetic protected-dir list, never the
// developer's real home.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Directories under a home that tests must never write to. */
export const PROTECTED_RELATIVE = [
  '.claude',
  '.codex',
  '.config/opencode',
  '.config/systemd',
  '.pi',
  '.gemini',
  '.copilot',
  '.omp',
  '.oh-omp',
  '.aiot',
  'Library/LaunchAgents',
];

/** Every protected directory under each of `homes`. */
export function protectedDirsFor(homes: readonly string[]): string[] {
  return homes.flatMap((home) => PROTECTED_RELATIVE.map((d) => join(resolve(home), d)));
}

/** `path` with symlinks resolved as far as it exists (a new file resolves via its parent). */
function realish(path: string): string {
  const rest: string[] = [];
  let cur = path;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) {
      return path;
    }
    rest.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    return path;
  }
}

function within(abs: string, dir: string): boolean {
  return abs === dir || abs.startsWith(`${dir}/`);
}

/**
 * Throw if `target` is, or (through symlinks) resolves to, a path under one of
 * `dirs`. `dirs` is read on every call, so tests can add a fake protected dir.
 * Values that are not a path (file descriptors, BunFile-less shapes) pass: the
 * path-opening call that produced the fd was already checked.
 */
export function refuseIfProtected(target: unknown, dirs: readonly string[]): void {
  let text: string;
  if (typeof target === 'string') {
    text = target;
  } else if (target instanceof URL) {
    text = target.pathname;
  } else if (target instanceof Uint8Array) {
    text = Buffer.from(target).toString();
  } else if (
    typeof target === 'object' &&
    target !== null &&
    typeof (target as { name?: unknown }).name === 'string'
  ) {
    text = (target as { name: string }).name; // Bun.file(path)
  } else {
    return;
  }
  const abs = resolve(text);
  const real = realish(abs);
  for (const dir of dirs) {
    const realDir = realish(dir);
    if (within(abs, dir) || within(real, dir) || within(abs, realDir) || within(real, realDir)) {
      throw new Error(
        `[aiot test isolation] refusing to write under the real home: ${abs}. ` +
          'Tests must use a temp HOME (set up by test-setup/isolate-home.ts).',
      );
    }
  }
}

/** open/openSync flags that can modify the file (default `r` cannot). */
export function opensForWrite(flags: unknown): boolean {
  return !(flags === undefined || flags === 'r' || flags === 'rs' || flags === 0);
}
