const STDIN_TIMEOUT_MS = 100;
const MAX_STDIN_BYTES = 1_048_576; // 1 MB

// Streams stdin, enforcing both a wall-clock timeout AND a hard byte cap.
// Critically, this *cancels* the underlying read on timeout/overflow rather
// than letting it continue draining in the background — which both keeps the
// hook within its <10ms budget when Claude Code holds the pipe and prevents
// a misbehaving sender from making us buffer arbitrary amounts of data.
export async function readStdinBounded(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const cancel = (reason: string) =>
    reader.cancel(reason).catch(() => {
      // Cancel failures are non-fatal — caller has already gotten what we have.
    });

  const timer = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), STDIN_TIMEOUT_MS);
  });

  try {
    while (true) {
      const next = await Promise.race([reader.read(), timer]);
      if (next === 'timeout') {
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
        await cancel('byte-cap');
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    await cancel('read-error');
    return '';
  }

  if (total === 0) {
    return '';
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}
