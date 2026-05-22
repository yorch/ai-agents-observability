import { existsSync, readFileSync } from 'node:fs';

import type { FlusherStatus } from '../flusher';
import { flusherStatePath, identityPath, pausedPath, queuePath } from '../lib/paths';
import { openQueueReader } from '../lib/queue-reader';

export async function runStatus(): Promise<number> {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  let authLine = 'not logged in';
  try {
    const raw = readFileSync(identityPath(), 'utf8');
    const parsed = JSON.parse(raw) as { token?: string; user_id_claim?: string };
    if (parsed.token) {
      authLine = parsed.user_id_claim ? `logged in as ${parsed.user_id_claim}` : 'logged in';
    }
  } catch {
    // identity.json missing or unreadable
  }

  // ── Paused ────────────────────────────────────────────────────────────────────
  const paused = existsSync(pausedPath());

  // ── Flusher state ─────────────────────────────────────────────────────────────
  let flusherState: FlusherStatus = { lastError: null, lastFlushAt: null, queueDepth: 0 };
  try {
    flusherState = JSON.parse(readFileSync(flusherStatePath(), 'utf8')) as FlusherStatus;
  } catch {
    // state file missing or unreadable
  }

  // ── Live queue depth (best-effort) ────────────────────────────────────────────
  let queueDepth = flusherState.queueDepth;
  if (existsSync(queuePath())) {
    try {
      const reader = openQueueReader(queuePath());
      queueDepth = reader.depth();
      reader.close();
    } catch {
      // DB locked or unreadable; use cached value from flusher state
    }
  }

  // ── Service status ────────────────────────────────────────────────────────────
  let flusherRunning: string | null = null;
  let shipperRunning: string | null = null;

  if (process.platform === 'darwin') {
    flusherRunning = checkLaunchctl('com.claude-telemetry.flusher');
    shipperRunning = checkLaunchctl('com.claude-telemetry.shipper');
  } else if (process.platform === 'linux') {
    flusherRunning = checkSystemctl('claude-telemetry-flusher');
    shipperRunning = checkSystemctl('claude-telemetry-shipper');
  }

  // ── Output ────────────────────────────────────────────────────────────────────
  const lines: string[] = [
    `auth:        ${authLine}`,
    `paused:      ${paused ? 'yes' : 'no'}`,
    `queue depth: ${queueDepth}`,
    `last flush:  ${flusherState.lastFlushAt ?? 'never'}`,
    `last error:  ${flusherState.lastError ?? 'none'}`,
  ];
  if (flusherRunning !== null) lines.push(`flusher:     ${flusherRunning}`);
  if (shipperRunning !== null) lines.push(`shipper:     ${shipperRunning}`);

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function checkLaunchctl(label: string): string {
  try {
    const result = Bun.spawnSync(['launchctl', 'list', label]);
    return result.exitCode === 0 ? 'running' : 'not running';
  } catch {
    return 'unknown';
  }
}

function checkSystemctl(unit: string): string {
  try {
    const result = Bun.spawnSync(['systemctl', '--user', 'is-active', unit]);
    const out = new TextDecoder().decode(result.stdout).trim();
    return out === 'active' ? 'running' : 'not running';
  } catch {
    return 'unknown';
  }
}
