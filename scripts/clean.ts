/**
 * Removes build artifacts and tool caches from the working tree.
 *
 * Why this exists: `.turbo/cache` reached 22 GB on a developer machine before
 * anyone noticed (see the `!.next/dev/**` exclusion in `turbo.json`). Turborepo
 * never garbage-collects its local cache, Next keeps a persistent Turbopack
 * cache under `.next/`, and `apps/hook` writes four cross-compiled binaries to
 * `dist/`. Nothing prunes any of it, so the only way back to a clean tree was a
 * hand-written `rm -rf` — which is exactly the command you do not want people
 * improvising next to a `data/` directory holding the Postgres bind mount.
 *
 * The target list is therefore explicit rather than a recursive name sweep. A
 * `find . -type d -name build -exec rm -rf` would also match any source
 * directory that happens to be called `build`, and the failure mode of guessing
 * wrong here is deleted work. Directories are removed only at the repo root and
 * at workspace roots; anything else needs a line in EXTRA_PATHS.
 *
 * Deliberately NOT removed:
 *   - `data/` and `infra/.minio-data/` — stack state, not build output. Wiping
 *     these drops the database. That is what `docker:infra:down:v` is for, and
 *     it is marked destructive on purpose.
 *   - `node_modules/` — reinstalling is a separate, much slower decision.
 *   - `packages/db/src/generated/` — the Prisma client. It is generated, but
 *     `typecheck` fails without it, so removing it would leave the repo broken
 *     until the next build. Run `bun run db:generate` if you actually want it
 *     rebuilt.
 *
 * Usage: bun run clean [--dry-run]
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/** Removed from the repo root and from every workspace root. */
const ARTIFACT_DIRS = ['.astro', '.next', '.turbo', 'build', 'coverage', 'dist'];

/** Repo-root-relative paths that do not follow the per-workspace pattern. */
const EXTRA_PATHS = ['apps/hook/bin', 'apps/hook/launcher/target'];

const ROOT = resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

/** Workspace roots, from the `workspaces.packages` globs in package.json. */
async function workspaceRoots(): Promise<string[]> {
  const manifest = await Bun.file(join(ROOT, 'package.json')).json();
  const patterns: string[] = manifest.workspaces?.packages ?? [];
  const roots: string[] = [];

  for (const pattern of patterns) {
    // Every pattern in this repo is a single-level `<dir>/*`.
    const parent = pattern.replace(/\/\*$/, '');
    const entries = await readdir(join(ROOT, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        roots.push(join(parent, entry.name));
      }
    }
  }

  return roots.sort();
}

/** Total bytes under `path`, following no symlinks. */
async function sizeOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) {
    return 0;
  }
  if (!info.isDirectory()) {
    return info.size;
  }

  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    total += await sizeOf(join(path, entry.name));
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const targets = ['', ...(await workspaceRoots())]
  .flatMap((root) => ARTIFACT_DIRS.map((dir) => join(root, dir)))
  .concat(EXTRA_PATHS)
  .map((path) => join(ROOT, path));

let reclaimed = 0;
let removed = 0;

for (const target of targets) {
  // Guard against a bad join escaping the repo — the one failure worth a check.
  if (!target.startsWith(`${ROOT}/`)) {
    throw new Error(`refusing to remove ${target}`);
  }
  if (!(await stat(target).catch(() => null))) {
    continue;
  }

  const bytes = await sizeOf(target);
  reclaimed += bytes;
  removed += 1;
  console.log(
    `  ${DRY_RUN ? 'would remove' : 'removed'} ${relative(ROOT, target)} (${formatBytes(bytes)})`,
  );

  if (!DRY_RUN) {
    await rm(target, { force: true, recursive: true });
  }
}

console.log(
  removed === 0
    ? 'clean: nothing to remove.'
    : `clean: ${DRY_RUN ? 'would reclaim' : 'reclaimed'} ${formatBytes(reclaimed)} from ${removed} path(s).`,
);
