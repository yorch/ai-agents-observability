import type { PrismaClient } from '@ai-agents-observability/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startScheduler } from '../src/jobs/scheduler';

/**
 * The scheduler's manual-trigger path, which had no test at all.
 *
 * `Run now` on /admin/jobs sets `run_requested_at`; this poll loop is what
 * dispatches it. Until recently the loop handled that branch and `continue`d
 * *before* the `enabled` check — which sat only on the scheduled path — so an
 * admin could start a disabled `judge-sessions` (paid model reads of developer
 * transcripts) with one click, and neither the UI nor the backend refused.
 *
 * Nothing pinned the old behaviour and nothing pinned the fix: `jobs.test.ts`
 * covers `sweep-abandoned` only and `admin-security.test.ts` never reaches
 * `startScheduler`. This file exists so the refusal cannot be undone silently.
 *
 * The refusal is deliberately scoped to CONFIGURABLE_JOBS, and that scoping is
 * asserted here too — for every other name `enabled: false` is not an operator
 * decision but the placeholder row `POST /admin/jobs/:name/run` upserts for a
 * job with no cadence, so refusing those would break the operator-drain path.
 */

function makeDeps(configs: Array<Record<string, unknown>>) {
  const jobConfigUpdate = vi.fn(async () => ({}));
  const jobRunCreate = vi.fn(async () => ({ id: 1n }));
  const warn = vi.fn();

  const db = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ pg_try_advisory_lock: true }]),
    jobConfig: {
      findMany: vi.fn(async () => configs),
      update: jobConfigUpdate,
    },
    jobRun: {
      create: jobRunCreate,
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
  };

  return {
    db,
    deps: {
      bucket: 'test',
      db: db as unknown as PrismaClient,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    } as never,
    jobConfigUpdate,
    jobRunCreate,
    warn,
  };
}

/**
 * Did the loop take the refusal branch?
 *
 * `runRequestedAt` is cleared on BOTH paths — a successful dispatch clears it
 * too — so the clear cannot discriminate. The refusal log line can.
 */
function refused(warn: ReturnType<typeof vi.fn>): boolean {
  return warn.mock.calls.some((args) =>
    args.some((a) => typeof a === 'string' && a.includes('manual run refused')),
  );
}

/** A job_config row with a manual trigger pending. */
function pending(jobName: string, enabled: boolean) {
  return {
    enabled,
    jobName,
    runHourUtc: 0,
    runMinuteUtc: 0,
    // Far in the past, so the "already ran since it was requested" guard cannot
    // be what suppresses dispatch — the enabled check must be what does.
    runRequestedAt: new Date('2020-01-01T00:00:00Z'),
  };
}

/** Run one poll tick. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000);
  // The loop body is async and detached (`void (async () => …)`), so let its
  // continuations drain before asserting.
  await vi.advanceTimersByTimeAsync(0);
}

describe('scheduler manual-trigger path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('refuses a manual run for a DISABLED configurable job', async () => {
    const { deps, jobConfigUpdate, jobRunCreate, warn } = makeDeps([
      pending('judge-sessions', false),
    ]);

    startScheduler(deps);
    await tick();

    expect(refused(warn)).toBe(true);
    // Not dispatched: no job_runs row was opened for it.
    expect(jobRunCreate).not.toHaveBeenCalled();
    // And the request is cleared, so it neither re-refuses every 60s nor fires
    // the moment someone re-enables the job for an unrelated reason.
    expect(jobConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { runRequestedAt: null },
        where: { jobName: 'judge-sessions' },
      }),
    );
  });

  it('does NOT refuse a manual run for a disabled NON-configurable job', async () => {
    // `enabled: false` on these is a placeholder, not an operator switch — the
    // ingest admin router mints the row that way for jobs that only ever run by
    // hand. Refusing them would break the operator drain rather than protect
    // anything, so the refusal must not clear their request.
    const { deps, warn } = makeDeps([pending('reprice-events-apply', false)]);

    startScheduler(deps);
    await tick();

    expect(refused(warn)).toBe(false);
  });

  it('lets an ENABLED configurable job through the refusal branch', async () => {
    // Positive control: proves the assertions above discriminate, rather than
    // passing because nothing ever dispatches in this harness.
    const { deps, warn } = makeDeps([pending('judge-sessions', true)]);

    startScheduler(deps);
    await tick();

    expect(refused(warn)).toBe(false);
  });
});
