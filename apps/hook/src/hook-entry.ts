import { existsSync } from 'node:fs';

import { type HookAdapter, selectAdapter } from './adapters';
import { commitDeferred, discardDeferred, resetDeferred } from './lib/deferred-commit';
import { getGitContext } from './lib/git';
import { log } from './lib/log';
import { pausedPath } from './lib/paths';
import { openQueue } from './lib/queue';
import { readStdinBounded } from './lib/stdin';
import { writeShipMarker } from './shipper';

type Options = {
  quiet: boolean;
};

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
    const target = adapter.transcriptTarget(kind, payload);
    if (target) {
      writeShipMarker(target.sessionId, target.transcriptPath, false);
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
