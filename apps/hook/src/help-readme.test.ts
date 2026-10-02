import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `aiot --help` only prints, so running the real entrypoint is side-effect free.
const hookDir = join(import.meta.dir, '..');

function readmeUsageBlock(): string {
  const readme = readFileSync(join(hookDir, 'README.md'), 'utf8');
  const match = readme.match(/## Usage\n\n```\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error('README.md has no fenced block under "## Usage"');
  }
  return match[1];
}

describe('README Usage block', () => {
  it('is the literal output of `aiot --help` (version line aside)', () => {
    const run = Bun.spawnSync([process.execPath, 'src/cli.ts', '--help'], { cwd: hookDir });
    expect(run.exitCode).toBe(0);
    // The README shows a `vX.Y.Z` placeholder so it never rots; help prints the real version.
    const readme = readmeUsageBlock();
    expect(readme.split('\n')[0]).toBe('aiot vX.Y.Z');
    const stripVersion = (text: string) => text.trimEnd().replace(/^aiot v\S+/, 'aiot v<version>');
    expect(stripVersion(readme)).toBe(stripVersion(run.stdout.toString()));
  });
});
