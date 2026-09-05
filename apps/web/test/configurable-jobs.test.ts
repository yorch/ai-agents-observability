import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONFIGURABLE_JOBS } from '../src/lib/configurable-jobs';

/**
 * `CONFIGURABLE_JOBS` is declared twice — here and in
 * `apps/ingest/src/jobs/scheduler.ts` — because `apps/web` cannot import from
 * `apps/ingest`. A duplicated definition two workspaces must agree on is exactly
 * the shape this repo has been bitten by before, so it gets pinned rather than
 * trusted.
 *
 * Drift is silent in both directions and neither is caught by types:
 *
 *   in web, not ingest — the form offers a cadence for a job the scheduler will
 *                        never read one for. The admin sets a time; nothing runs.
 *   in ingest, not web — the job has a real editable cadence, but the page
 *                        refuses to edit it and labels it "operator-triggered
 *                        only", which is a lie about a job that has a schedule.
 *
 * Reads the scheduler's source as text — the same technique
 * `turn-linkage.test.ts` uses to pin the hook's metadata key across a boundary
 * the type system does not cross.
 */

const SCHEDULER = join(import.meta.dirname, '../../../apps/ingest/src/jobs/scheduler.ts');

/** The literal array under `const CONFIGURABLE_JOBS = [ ... ] as const;`. */
function schedulerConfigurableJobs(): Set<string> {
  const src = readFileSync(SCHEDULER, 'utf8');
  const match = src.match(/const CONFIGURABLE_JOBS = \[([\s\S]*?)\] as const;/);
  if (!match?.[1]) {
    throw new Error(
      'Could not find `const CONFIGURABLE_JOBS = [...] as const;` in the ingest scheduler. ' +
        'If it was renamed or reshaped, update this test rather than deleting it — ' +
        'the two lists still have to agree.',
    );
  }
  return new Set([...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string));
}

describe('the web and ingest configurable-job lists agree', () => {
  it('finds a non-trivial list in the scheduler', () => {
    // Guards against the comparison below passing because the regex matched an
    // empty array — a green result must mean "compared", never "found nothing".
    expect(schedulerConfigurableJobs().size).toBeGreaterThan(5);
  });

  it('has no job the web page offers that the scheduler will not schedule', () => {
    const ingest = schedulerConfigurableJobs();
    expect([...CONFIGURABLE_JOBS].filter((name) => !ingest.has(name))).toEqual([]);
  });

  it('has no job the scheduler schedules that the web page refuses to edit', () => {
    const ingest = schedulerConfigurableJobs();
    expect([...ingest].filter((name) => !CONFIGURABLE_JOBS.has(name))).toEqual([]);
  });
});
