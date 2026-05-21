const STDIN_TIMEOUT_MS = 100;
const MAX_STDIN_BYTES = 1_048_576; // 1 MB

export async function readStdinBounded(): Promise<string> {
  const timer = new Promise<string>((resolve) => {
    setTimeout(() => resolve(''), STDIN_TIMEOUT_MS);
  });
  const reader = (async () => {
    const text = await Bun.stdin.text();
    return text.length > MAX_STDIN_BYTES ? text.slice(0, MAX_STDIN_BYTES) : text;
  })();
  return Promise.race([reader, timer]);
}
