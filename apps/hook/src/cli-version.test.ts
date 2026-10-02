import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Release automation bumps apps/hook/package.json and nothing else, so that is the
// only place the CLI may take its version from. A literal in cli.ts drifted to
// 0.1.0 while the package was at 2.8.0.
const hookDir = join(import.meta.dir, '..');
const pkgVersion = (
  JSON.parse(readFileSync(join(hookDir, 'package.json'), 'utf8')) as { version: string }
).version;

function run(...args: string[]): string {
  const r = Bun.spawnSync([process.execPath, 'src/cli.ts', ...args], { cwd: hookDir });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString();
}

describe('aiot version', () => {
  it('--version prints the package.json version', () => {
    expect(run('--version').trim()).toBe(pkgVersion);
    expect(run('-V').trim()).toBe(pkgVersion);
  });

  it('--help leads with the package.json version', () => {
    expect(run('--help').split('\n')[0]).toBe(`aiot v${pkgVersion}`);
  });
});
