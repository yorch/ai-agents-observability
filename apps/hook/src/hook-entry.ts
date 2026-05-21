import { log } from './lib/log.js';
import { type HookKind, toEvent } from './lib/payload.js';
import { openQueue } from './lib/queue.js';
import { readStdinBounded } from './lib/stdin.js';

type Options = {
  quiet: boolean;
};

function safeParse(raw: string): Record<string, unknown> | null {
  if (!raw) {
    return {};
  }
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
export async function runHook(kind: HookKind, opts: Options): Promise<void> {
  try {
    const raw = await readStdinBounded();
    const payload = safeParse(raw);
    if (!payload) {
      log('warn', 'hook.payload.invalid_json', { kind });
      return;
    }

    const event = toEvent(kind, payload);

    let queue: ReturnType<typeof openQueue>;
    try {
      queue = openQueue();
    } catch (err) {
      log('error', 'hook.queue.open_failed', { kind, message: (err as Error).message });
      return;
    }

    try {
      queue.enqueue({
        event_id: event.event_id,
        payload_json: JSON.stringify(event),
        ts: event.ts,
      });
    } catch (err) {
      log('error', 'hook.queue.enqueue_failed', { kind, message: (err as Error).message });
    } finally {
      try {
        queue.close();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    if (!opts.quiet) {
      // Even in non-quiet mode, write to log file — stderr from a hook can
      // surface inside the Claude Code transcript.
      log('error', 'hook.unexpected', { kind, message: (err as Error).message });
    } else {
      log('error', 'hook.unexpected', { kind, message: (err as Error).message });
    }
  }
}
