import { createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';

type Os = 'darwin' | 'linux' | 'win32';

let cached: { claude_code_version: string; hostname_hash: string; os: Os } | null = null;

function resolveOs(): Os {
  const p = platform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') {
    return p;
  }
  // Anything exotic (freebsd, aix, …) is reported as linux for ingest's enum.
  return 'linux';
}

export function clientInfo(): { claude_code_version: string; hostname_hash: string; os: Os } {
  if (cached) {
    return cached;
  }
  const hashHex = createHash('sha256').update(hostname()).digest('hex');
  cached = {
    claude_code_version: process.env.CLAUDE_CODE_VERSION ?? 'unknown',
    hostname_hash: `sha256:${hashHex.slice(0, 16)}`,
    os: resolveOs(),
  };
  return cached;
}
