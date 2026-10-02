import { existsSync } from 'node:fs';

import { type HookAdapter, selectAdapter } from './adapters';
import { commitDeferred, discardDeferred, resetDeferred } from './lib/deferred-commit';
import { maybeSpawnDrainer } from './lib/drainer-spawn';
import { getGitContext } from './lib/git';
import { log } from './lib/log';
import { pausedPath } from './lib/paths';
import { openQueue, type Queue, type QueuedEvent } from './lib/queue';
import { readStdinBounded } from './lib/stdin';
import { markShipFinal, writeShipMarker } from './shipper';

type Options = {
  quiet: boolean;
};

/**
 * Event types after which an on-demand install starts a drainer. Tool-lifecycle
 * hooks are deliberately absent: they fire orders of magnitude more often and
 * must stay free of any extra work.
 */
const DRAIN_TRIGGERS = new Set(['Stop', 'SubagentStop', 'SessionEnd', 'SessionStart']);

/**
 * A SessionEnd's bulk usage pass (`HookAdapter.tail`) stops starting new chunks this
 * long after the hook started. Claude Code kills a SessionEnd hook at its deadline
 * (1.5 s unless a hook entry sets a longer `timeout`), and the primary event, the
 * ship marker and the drainer spawn all have to fit before it. What is not read stays
 * behind the cursor for the next Stop, SessionEnd or import.
 */
const TAIL_BUDGET_MS = 700;
/** Rows per transaction: ~5 ms, well inside the 100 ms busy timeout. */
export const TAIL_CHUNK_ROWS = 100;
/** After a chunk, the tail pauses this many times as long as the chunk took (25% duty). */
const TAIL_PAUSE_FACTOR = 3;
const TAIL_MIN_PAUSE_MS = 2;
const TAIL_MAX_PAUSE_MS = 20;

/**
 * One chunk, retrying while another process holds the write lock (the connection's
 * 100 ms busy timeout already waited once). Gives up at the deadline by throwing,
 * which leaves the cursor at the last committed chunk.
 */
function enqueueChunk(queue: Queue, rows: QueuedEvent[], deadline: number): boolean {
  for (;;) {
    try {
      return queue.enqueueMany(rows);
    } catch (err) {
      if (!(err as Error).message.includes('database is locked') || Date.now() >= deadline) {
        throw err;
      }
      Bun.sleepSync(10);
    }
  }
}

/**
 * Queue an adapter's bulk events chunk by chunk, committing its cursor after each.
 * Never throws (a hook always exits 0). Stops at the deadline, at an exhausted
 * adapter, or when the queue has no room (nothing is ever pruned to make room: the
 * cursor would move past rows that pruning then deleted).
 */
function queueTail(
  queue: Queue,
  adapter: HookAdapter,
  kind: string,
  payload: Record<string, unknown>,
  startedAt: number,
): void {
  if (!adapter.tail) {
    return;
  }
  const deadline = startedAt + TAIL_BUDGET_MS;
  let queued = 0;
  try {
    for (const chunk of adapter.tail(kind, payload, {
      chunkSize: TAIL_CHUNK_ROWS,
      shouldStop: () => Date.now() >= deadline,
    })) {
      const rows: QueuedEvent[] = chunk.events.map((e) => ({
        event_id: e.event_id,
        payload_json: JSON.stringify(e),
        ts: e.ts,
      }));
      const began = performance.now();
      if (!enqueueChunk(queue, rows, deadline)) {
        log('warn', 'hook.tail.queue_full', { kind, queued });
        return;
      }
      queued += rows.length;
      chunk.commit();
      // Let go of the write lock for a while. A writer that finds the database busy
      // sleeps between retries (SQLite's busy handler backs off 1, 2, 5, 10 ... 100 ms),
      // so back-to-back chunks would hold the lock almost continuously and starve the
      // tool hooks of other sessions past their 100 ms timeout. The pause scales with
      // the chunk's time (about 25% duty) but is capped: `elapsed` also contains time
      // spent waiting for ANOTHER process's lock and the post-commit checkpoint, which
      // is not time this hook held anything, and sleeping 3x that (a 351 ms wait made a
      // 1 s pause) pushed the hook past Claude Code's kill, after the marker but before
      // the drainer spawn. It never sleeps past the deadline either.
      const elapsed = performance.now() - began;
      Bun.sleepSync(
        Math.min(
          TAIL_MAX_PAUSE_MS,
          Math.max(0, deadline - Date.now()),
          Math.max(TAIL_MIN_PAUSE_MS, elapsed * TAIL_PAUSE_FACTOR),
        ),
      );
    }
  } catch (err) {
    log('error', 'hook.tail.failed', { kind, message: (err as Error).message, queued });
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The events one hook invocation produces.
 *
 * An adapter may expand one invocation into several events (codex reads a turn's
 * tool calls + usage out of its rollout file), into exactly one, or into NONE —
 * Gemini's AfterModel is harvested for token usage and deliberately emits
 * nothing.
 *
 * The nullish coalescing is load-bearing: with `||`, an empty batch would fall
 * through to `mapPayload` and fabricate an event for every such hook. Extracted
 * so that contract can be tested without a second read of the process's stdin.
 */
export function eventsFor(
  adapter: HookAdapter,
  kind: string,
  payload: Record<string, unknown>,
): ReturnType<HookAdapter['mapPayload']>[] {
  return adapter.mapBatch?.(kind, payload) ?? [adapter.mapPayload(kind, payload)];
}

// Run a single hook entrypoint. Always resolves; the caller exits 0 regardless.
// Errors are logged and swallowed — a broken hook MUST NOT break Claude Code.
export async function runHook(
  kind: string,
  _opts: Options,
  adapter: HookAdapter = selectAdapter(),
): Promise<void> {
  // One hook invocation per process, but clear defensively so a test (or any
  // future in-process reuse) cannot inherit another run's pending commits.
  resetDeferred();
  const startedAt = Date.now();

  try {
    if (existsSync(pausedPath())) {
      return;
    }

    const stdin = await readStdinBounded();

    // Distinct outcomes for distinct stdin states — never synthesize a bogus
    // event from empty/timeout/error input. If Claude Code didn't give us a
    // real payload, we have nothing to enqueue.
    if (stdin.kind === 'empty') {
      log('warn', 'hook.stdin.empty', { kind });
      return;
    }
    if (stdin.kind === 'timeout') {
      log('warn', 'hook.stdin.timeout', { kind });
      return;
    }
    if (stdin.kind === 'error') {
      log('error', 'hook.stdin.read_error', { kind });
      return;
    }
    if (stdin.kind === 'overflow') {
      log('warn', 'hook.stdin.overflow', { kind });
      return;
    }

    const payload = safeParse(stdin.text);
    if (!payload) {
      log('warn', 'hook.payload.invalid_json', { kind });
      return;
    }

    const events = eventsFor(adapter, kind, payload);

    // Snapshot git context at session-start time so the session row records the
    // branch as of when work began, not when the flusher drains. The flusher
    // skips events that already have git set, so this value is preserved.
    // Only runs once per session (SessionStart fires once) — acceptable latency.
    for (const event of events) {
      if (
        event.event_type === 'SessionStart' &&
        event.session_context.git === null &&
        event.session_context.cwd.length > 0
      ) {
        const git = getGitContext(event.session_context.cwd);
        if (git) {
          event.session_context.git = git;
        }
      }
    }

    let queue: ReturnType<typeof openQueue>;
    try {
      queue = openQueue();
    } catch (err) {
      log('error', 'hook.queue.open_failed', { kind, message: (err as Error).message });
      // The adapter has already read its side channel. Do NOT commit that read:
      // nothing was queued, so the next invocation must see the same data again.
      discardDeferred('queue_open_failed');
      return;
    }

    let enqueued = 0;
    for (const event of events) {
      try {
        queue.enqueue({
          event_id: event.event_id,
          payload_json: JSON.stringify(event),
          ts: event.ts,
        });
        enqueued += 1;
      } catch (err) {
        log('error', 'hook.queue.enqueue_failed', { kind, message: (err as Error).message });
      }
    }

    // The commit point. Adapters register their destructive side-channel reads
    // (a transcript cursor, a usage accumulator) rather than performing them, so
    // that consuming the source and durably recording what was consumed cannot
    // come apart — which is what happened before: the cursor advanced while
    // building the events, and an enqueue failure then dropped them for good,
    // taking the only live record of that turn's token usage with it.
    //
    // Committing on a PARTIAL enqueue is deliberate. The queue dedupes on
    // event_id, and the ids here are deterministic (derived from the transcript
    // entry), so re-reading a committed turn is a no-op rather than a double
    // count — while not committing after a partial success would re-read every
    // turn on every subsequent invocation, which grows without bound.
    if (enqueued > 0) {
      commitDeferred();
    } else if (events.length > 0) {
      discardDeferred('enqueue_failed');
    }

    // For terminal events, the adapter tells us where the transcript lives; write
    // a ship marker so the shipper can upload it.
    const ended = events.find((e) => e.event_type === 'SessionEnd');
    const target = adapter.transcriptTarget(kind, payload);
    if (target) {
      writeShipMarker(target.sessionId, target.transcriptPath, false, {
        final: ended !== undefined,
      });
    } else if (ended) {
      // An adapter that only writes a marker on Stop never sees the end of the
      // session; flag the existing marker so an on-demand drainer ships it now.
      markShipFinal(ended.session_id);
    }

    // The bulk part of a SessionEnd (usage for the turns after the last Stop) comes
    // AFTER its own event is queued and its marker written, and BEFORE the drainer
    // spawn, so the drainer finds the turns. A kill anywhere in here leaves the
    // durable SessionEnd and marker (the next SessionStart's catch-up spawns the
    // drainer) and a cursor that is exact for whatever was queued.
    if (ended) {
      queueTail(queue, adapter, kind, payload, startedAt);
    }

    // On-demand installs have no resident daemon: start a short-lived drainer,
    // but only after a terminal event that either queued something or opened a
    // session (catch-up for data left by an earlier, undelivered one). The
    // spawn decision is a claim on the connection already open.
    if (
      events.some((e) => DRAIN_TRIGGERS.has(e.event_type)) &&
      (enqueued > 0 || events.some((e) => e.event_type === 'SessionStart'))
    ) {
      // A SessionEnd is the last chance to ship that session, so it ignores the
      // backoff a failing environment has put on spawning (never the burst dedupe).
      maybeSpawnDrainer(queue, { bypassHold: events.some((e) => e.event_type === 'SessionEnd') });
    }

    try {
      queue.close();
    } catch {
      // ignore
    }
  } catch (err) {
    // Stderr from a hook surfaces inside the Claude Code transcript, so even
    // in --quiet mode unexpected failures go only to the log file.
    log('error', 'hook.unexpected', { kind, message: (err as Error).message });
  }
}
