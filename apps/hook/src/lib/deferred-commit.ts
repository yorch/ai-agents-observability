import { log } from './log';

/**
 * Side effects an adapter must not perform until its events are safely queued.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Three adapters consume a side channel while building their terminal event, and
 * each consumed it *destructively, inside `mapBatch`*:
 *
 *   - `claude-code` advances a per-session byte cursor past the transcript lines
 *     it just read;
 *   - `codex` advances the equivalent cursor over its rollout file;
 *   - `gemini-cli` deletes the per-turn usage accumulator it just read.
 *
 * `hook-entry` calls `eventsFor()` — and therefore all of that — *before* it
 * opens the SQLite queue and before it enqueues. Both of those can fail (a full
 * disk, a locked or corrupt `queue.db`), and both failures only log and move on.
 * The side channel was already consumed, so the next invocation reads from the
 * new offset, or finds no accumulator, and those turns are gone for good.
 *
 * What is lost is not generic telemetry. Those turns carry the `llm` block that
 * is the only live source of token usage for these agents (P14-003), so
 * `events.cost_usd` is NULL for them and `sessions.total_cost_usd` — which is
 * accumulated at ingest and never recomputed — stays permanently low. Nothing
 * surfaces it: the dashboard shows a confident, wrong number.
 *
 * HOW THIS FIXES IT
 *
 * An adapter registers the consumption instead of performing it, and
 * `hook-entry` runs the registered work only after the events are in the queue.
 * A failure before that point simply never commits, so the next invocation
 * re-reads the same lines and the data survives.
 *
 * That trade is deliberate and it is not symmetric: not committing risks
 * counting a turn twice on a later run, while committing early loses it
 * outright. `gemini-cli` had already reasoned its way to the same preference in
 * a comment on `drainUsage` ("losing the event is worse than … counting the same
 * tokens twice"); this makes that choice hold for the enqueue failure too, not
 * just for a failed file removal.
 *
 * WHY MODULE STATE IS SAFE HERE
 *
 * `hook <kind>` is one invocation per process — the binary handles a single hook
 * and exits — so this list has exactly one logical owner. `runHook` still clears
 * it on entry so a test (or any future in-process reuse) cannot inherit another
 * run's pending work.
 */

type Deferred = { label: string; run: () => void };

const pending: Deferred[] = [];

/**
 * Register work to run once this invocation's events are safely queued.
 * `label` identifies it in the log if it fails.
 */
export function deferCommit(label: string, run: () => void): void {
  pending.push({ label, run });
}

/**
 * Run and clear everything registered. Call ONLY after the events are queued.
 *
 * Each entry is isolated: one failing commit must not strand the others, and
 * none of them may throw past `runHook`, which owes the host agent an exit 0.
 * A failed commit is logged and left uncommitted, which re-reads next time —
 * the same safe direction as never committing at all.
 */
export function commitDeferred(): void {
  const queued = pending.splice(0, pending.length);
  for (const { label, run } of queued) {
    try {
      run();
    } catch (err) {
      log('warn', 'hook.deferred_commit.failed', { label, message: (err as Error).message });
    }
  }
}

/**
 * Drop everything registered without running it — the events did not reach the
 * queue. Logs what was dropped, because a silently skipped commit and a
 * committed one are otherwise indistinguishable after the fact.
 */
export function discardDeferred(reason: string): void {
  if (pending.length === 0) {
    return;
  }
  const labels = pending.map((d) => d.label);
  pending.length = 0;
  log('warn', 'hook.deferred_commit.discarded', { labels: labels.join(','), reason });
}

/** Test seam: drop pending work without logging. Called at the top of `runHook`. */
export function resetDeferred(): void {
  pending.length = 0;
}
