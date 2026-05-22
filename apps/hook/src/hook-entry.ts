import { existsSync } from 'node:fs';

import { log } from './lib/log';
import { type HookKind, toEvent } from './lib/payload';
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
export async function runHook(kind: HookKind, _opts: Options): Promise<void> {
  if (existsSync(pausedPath())) {
    return;
  }

  try {
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
    }

    // For stop events, write a ship marker so the shipper can upload the
    // transcript. transcript_path comes from Claude Code's hook payload.
    if (
      kind === 'stop' &&
      typeof payload.transcript_path === 'string' &&
      payload.transcript_path.length > 0 &&
      typeof payload.session_id === 'string' &&
      payload.session_id.length > 0
    ) {
      writeShipMarker(payload.session_id, payload.transcript_path, false);
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
