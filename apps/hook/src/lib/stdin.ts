const STDIN_TIMEOUT_MS = 100;
const MAX_STDIN_BYTES = 1_048_576; // 1 MB

export type StdinResult =
  | { kind: 'ok'; text: string }
  | { kind: 'empty' }
  | { kind: 'timeout' }
  | { kind: 'overflow'; text: string }
  | { kind: 'error' };

// Streams stdin, enforcing both a wall-clock timeout AND a hard byte cap.
// Critically:
//   * cancels the underlying read on timeout/overflow so it can't keep draining;
//   * clears the timeout on the fast path so the orphan timer doesn't hold the
//     event loop open past the <10ms budget (this is the common case — most
//     hook payloads drain in well under a millisecond);
//   * distinguishes "empty stdin" from "timeout" from "error" so the caller
//     can decide whether to enqueue, drop, or surface — see hook-entry.ts.
export async function readStdinBounded(): Promise<StdinResult> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  let overflowed = false;

  const cancel = (reason: string) =>
    reader.cancel(reason).catch(() => {
      // Cancel failures are non-fatal — caller has already gotten what we have.
    });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), STDIN_TIMEOUT_MS);
  });

  try {
    while (true) {
      const next = await Promise.race([reader.read(), timer]);
      if (next === 'timeout') {
        timedOut = true;
        await cancel('timeout');
        break;
      }
      if (next.done) {
        break;
      }
      const remaining = MAX_STDIN_BYTES - total;
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.subarray(0, remaining));
        total = MAX_STDIN_BYTES;
        overflowed = true;
        await cancel('byte-cap');
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    await cancel('read-error');
    return { kind: 'error' };
  }

  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  if (timedOut && total === 0) {
    return { kind: 'timeout' };
  }
  if (total === 0) {
    return { kind: 'empty' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(merged);
  return overflowed ? { kind: 'overflow', text } : { kind: 'ok', text };
}
