import { existsSync } from 'node:fs';

import { type HookAdapter, selectAdapter } from './adapters';
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

// Run a single hook entrypoint. Always resolves; the caller exits 0 regardless.
// Errors are logged and swallowed — a broken hook MUST NOT break Claude Code.
export async function runHook(
  kind: string,
  _opts: Options,
  adapter: HookAdapter = selectAdapter(),
): Promise<void> {
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

    // An adapter may expand one hook invocation into several events (codex reads a
    // turn's tool calls + usage out of its rollout file); otherwise it's one event.
    const events = adapter.mapBatch?.(kind, payload) ?? [adapter.mapPayload(kind, payload)];

    let queue: ReturnType<typeof openQueue>;
    try {
      queue = openQueue();
    } catch (err) {
      log('error', 'hook.queue.open_failed', { kind, message: (err as Error).message });
      return;
    }

    for (const event of events) {
      try {
        queue.enqueue({
          event_id: event.event_id,
          payload_json: JSON.stringify(event),
          ts: event.ts,
        });
      } catch (err) {
        log('error', 'hook.queue.enqueue_failed', { kind, message: (err as Error).message });
      }
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
