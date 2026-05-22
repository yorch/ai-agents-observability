import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
  | { status: 'pending' }
  | { github_login: string; hook_token: string; status: 'authorized' };

export async function runLogin(): Promise<number> {
  const api = (process.env.CLAUDE_TELEMETRY_API ?? DEFAULT_API).replace(/\/$/, '');

  let startResult: StartResult;
  try {
    const res = await fetch(`${api}/api/auth/device/start`, { method: 'POST' });
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

  const intervalMs = Math.max((startResult.interval ?? 5) * 1_000, 5_000);
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
      continue;
    }

    if (pollResult.status !== 'authorized') {
      process.stderr.write(
        `Unexpected poll status: ${String((pollResult as { status: unknown }).status)}\n`,
      );
      return 1;
    }

    const { hook_token, github_login } = pollResult;
    const path = identityPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ token: hook_token, user_id_claim: github_login }, null, 2),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );

    process.stdout.write(`\nLogged in as ${github_login}\n`);
    return 0;
  }

  process.stderr.write('Device code expired. Run `claude-telemetry login` to try again.\n');
  return 1;
}
