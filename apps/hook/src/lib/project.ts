import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Walk up from `cwd` (at most 8 levels) to find the nearest `package.json`
 * with a non-empty `name` field. Returns the name or null if none is found.
 * An injectable `readFile` allows tests to avoid real filesystem access.
 */
export function getProjectName(
  cwd: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string | null {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    try {
      const raw = readFile(join(dir, 'package.json'));
      const pkg = JSON.parse(raw) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        return pkg.name;
      }
    } catch {
      // not found or not parseable — continue up
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}
