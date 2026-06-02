import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSweepScratch } from '../src/jobs/sweep-scratch';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sweep-scratch-test-'));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function makePartFile(name: string, ageMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

describe('runSweepScratch', () => {
  it('removes stale .zst.part scratch files and keeps fresh + unrelated ones', async () => {
    const stale = makePartFile('claude-telemetry-transcript-u1-s1.zst.part', 7 * 60 * 60 * 1_000);
    const fresh = makePartFile('claude-telemetry-transcript-u1-s2.zst.part', 60 * 1_000);
    const unrelated = makePartFile('some-other-file.txt', 7 * 60 * 60 * 1_000);

    const removed = await runSweepScratch(undefined, Date.now(), dir);

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('returns 0 when there is nothing to sweep', async () => {
    expect(await runSweepScratch(undefined, Date.now(), dir)).toBe(0);
  });
});
