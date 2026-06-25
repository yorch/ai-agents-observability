import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { identityPath } from '../lib/paths';

const DEFAULT_API = 'http://localhost:3000';
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

type StartResult = {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
};

type PollResult =
  | { status: 'pending'; slow_down?: boolean; interval?: number }
  | { github_login: string; hook_token: string; status: 'authorized' };

type TokenResult = { display_name: string; token: string };

// ── Interactive prompts ───────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);

    if (typeof process.stdin.setRawMode === 'function') {
      // TTY: read char-by-char without echoing characters
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let password = '';
      const handler = (char: string) => {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(password);
        } else if (char === '') {
          // Ctrl+C
          process.exit(1);
        } else if (char === '' || char === '\b') {
          // Backspace
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      };
      process.stdin.on('data', handler);
    } else {
      // Non-TTY fallback (piped input, CI): readline without masking
      const rl = createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        process.stdout.write('\n');
        resolve(line);
      });
    }
  });
}

// ── Password-based login ──────────────────────────────────────────────────────

async function runPasswordLogin(api: string): Promise<number> {
  process.stdout.write('\nGitHub OAuth is not configured on this server.\n');
  process.stdout.write('Log in with your email and password instead.\n\n');

  const email = await prompt('Email: ');
  if (!email) {
    process.stderr.write('Email is required.\n');
    return 1;
  }

  const password = await promptPassword('Password: ');
  if (!password) {
    process.stderr.write('Password is required.\n');
    return 1;
  }

  let result: TokenResult;
  try {
    const res = await fetch(`${api}/api/auth/token`, {
      body: JSON.stringify({ email, password }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (res.status === 401) {
      process.stderr.write('Invalid email or password.\n');
      return 1;
    }
    if (!res.ok) {
      process.stderr.write(`Login failed (${res.status}).\n`);
      return 1;
    }
    result = (await res.json()) as TokenResult;
  } catch (err) {
    process.stderr.write(`Cannot reach ${api}: ${(err as Error).message}\n`);
    return 1;
  }

  saveIdentity(result.token, result.display_name);
  process.stdout.write(`\nLogged in as ${result.display_name}\n`);
  return 0;
}

// ── Device flow (GitHub OAuth) ────────────────────────────────────────────────

async function runDeviceLogin(api: string): Promise<number> {
  let startResult: StartResult;
  try {
    const res = await fetch(`${api}/api/auth/device/start`, { method: 'POST' });
    if (res.status === 503) {
      return runPasswordLogin(api);
    }
    if (!res.ok) {
      process.stderr.write(`Failed to start device flow (${res.status}). Is ${api} reachable?\n`);
      return 1;
    }
    startResult = (await res.json()) as StartResult;
  } catch (err) {
    process.stderr.write(`Cannot reach ${api}: ${(err as Error).message}\n`);
    process.stderr.write('Set CLAUDE_TELEMETRY_API to the correct URL and try again.\n');
    return 1;
  }

  process.stdout.write('\nAuthenticate with GitHub:\n\n');
  process.stdout.write(`  Code: ${startResult.user_code}\n`);
  process.stdout.write(`  URL:  ${startResult.verification_uri}\n\n`);
  process.stdout.write('Waiting for authorization...\n');

  let intervalMs = Math.max((startResult.interval ?? 5) * 1_000, 5_000);
  const deadline = Date.now() + Math.min((startResult.expires_in ?? 900) * 1_000, POLL_TIMEOUT_MS);

  while (Date.now() < deadline) {
    await Bun.sleep(intervalMs);

    let pollResult: PollResult;
    try {
      const res = await fetch(`${api}/api/auth/device/poll`, {
        body: JSON.stringify({ device_code: startResult.device_code }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!res.ok) {
        process.stderr.write(`Poll failed (${res.status})\n`);
        return 1;
      }
      pollResult = (await res.json()) as PollResult;
    } catch (err) {
      // Transient network error — retry on next tick; deadline handles timeout.
      process.stderr.write(`Poll network error (retrying): ${(err as Error).message}\n`);
      continue;
    }

    if (pollResult.status === 'pending') {
      // Honor GitHub's slow_down: widen the interval (use the server-provided
      // value if present, otherwise add 5s per GitHub's guidance).
      if (pollResult.slow_down) {
        intervalMs = pollResult.interval ? pollResult.interval * 1_000 : intervalMs + 5_000;
      }
      continue;
    }

    if (pollResult.status !== 'authorized') {
      process.stderr.write(
        `Unexpected poll status: ${String((pollResult as { status: unknown }).status)}\n`,
      );
      return 1;
    }

    const { hook_token, github_login } = pollResult;
    saveIdentity(hook_token, github_login);
    process.stdout.write(`\nLogged in as ${github_login}\n`);
    return 0;
  }

  process.stderr.write('Device code expired. Run `claude-telemetry login` to try again.\n');
  return 1;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function saveIdentity(token: string, userIdClaim: string): void {
  const path = identityPath();
  mkdirSync(dirname(path), { recursive: true });
  // Token storage: deliberately a 0600 plaintext JSON file rather than the OS
  // keychain. The hook ships as a `bun build --compile` single binary, where the
  // native `keytar` addon cannot be reliably linked across the four cross-compiled
  // targets, and we need to persist structured identity (token + claim), not just a
  // bare secret. The 0600 file (owner-read/write only) is the same posture as
  // `~/.ssh` keys and `~/.aws/credentials`. The keytar-with-file-fallback path lives
  // in `@ai-agents-observability/auth` (keychain.ts) for non-compiled server contexts.
  writeFileSync(path, JSON.stringify({ token, user_id_claim: userIdClaim }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runLogin(): Promise<number> {
  const api = (process.env.CLAUDE_TELEMETRY_API ?? DEFAULT_API).replace(/\/$/, '');
  return runDeviceLogin(api);
}
