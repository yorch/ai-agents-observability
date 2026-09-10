import { existsSync, readFileSync } from 'node:fs';

import type { FlusherStatus } from '../flusher';
import { heartbeatAgeSeconds } from '../flusher';
import { getShipMode } from '../lib/config';
import { flusherStatePath, identityPath, pausedPath, queuePath } from '../lib/paths';
import { openQueueReader } from '../lib/queue-reader';

// Heartbeat staleness thresholds (seconds).
// A non-empty queue with a stale heartbeat means events are piling up and the
// flusher is not making progress — the most actionable signal. An idle queue
// with a stale heartbeat means the daemon is likely not running at all.
//
// The "with queue" threshold must exceed the largest possible gap between
// heartbeats. The flusher's exponential backoff caps at 300s (5 min), and the
// heartbeat is throttled to 30s. So a flusher in deep backoff + a 30s fetch
// can have a ~330s gap. 420s (7 min) gives comfortable headroom.
const STALE_HEARTBEAT_WITH_QUEUE_SEC = 420; // 7 min
const STALE_HEARTBEAT_IDLE_SEC = 3600; // 1 h

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

  // ── Ship mode ──────────────────────────────────────────────────────────────────
  const shipMode = getShipMode();

  // ── Flusher state ─────────────────────────────────────────────────────────────
  let flusherState: FlusherStatus = {
    lastError: null,
    lastFlushAt: null,
    lastHeartbeatAt: null,
    queueDepth: 0,
  };
  try {
    flusherState = JSON.parse(readFileSync(flusherStatePath(), 'utf8')) as FlusherStatus;
  } catch {
    // state file missing or unreadable
  }

  // ── Live queue depth (best-effort) ────────────────────────────────────────────
  let queueDepth = flusherState.queueDepth;
  if (existsSync(queuePath())) {
    let reader: ReturnType<typeof openQueueReader> | undefined;
    try {
      reader = openQueueReader(queuePath());
      queueDepth = reader.depth();
    } catch {
      // DB locked or unreadable; use cached value from flusher state
    } finally {
      reader?.close();
    }
  }

  // ── Service status ────────────────────────────────────────────────────────────
  let flusherRunning: string | null = null;
  let shipperRunning: string | null = null;

  if (process.platform === 'darwin') {
    flusherRunning = checkLaunchctl('com.brnby.aiot.flusher');
    shipperRunning = checkLaunchctl('com.brnby.aiot.shipper');
  } else if (process.platform === 'linux') {
    flusherRunning = checkSystemctl('aiot-flusher');
    shipperRunning = checkSystemctl('aiot-shipper');
  }

  // ── Output ────────────────────────────────────────────────────────────────────
  const heartbeatAge = heartbeatAgeSeconds(flusherState.lastHeartbeatAt);
  const lines: string[] = [
    `auth:        ${authLine}`,
    `paused:      ${paused ? 'yes' : 'no'}`,
    `ship mode:   ${shipMode}`,
    `queue depth: ${queueDepth}`,
    `last flush:  ${flusherState.lastFlushAt ?? 'never'}`,
    `last error:  ${flusherState.lastError ?? 'none'}`,
  ];
  if (heartbeatAge !== null) {
    lines.push(`heartbeat:    ${heartbeatAge}s ago`);
  } else {
    lines.push('heartbeat:    never');
  }

  // Staleness warning: the flusher can be loaded by launchd/systemd but stalled
  // (deadlocked on a DB lock, hung on a network call the timeout missed, or
  // simply not running). A stale heartbeat is a stronger signal than
  // `launchctl list` returning the label.
  if (heartbeatAge !== null) {
    if (queueDepth > 0 && heartbeatAge > STALE_HEARTBEAT_WITH_QUEUE_SEC) {
      lines.push(
        `WARNING: flusher heartbeat is ${heartbeatAge}s stale with ${queueDepth} events queued — the daemon may be stalled`,
      );
    } else if (queueDepth === 0 && heartbeatAge > STALE_HEARTBEAT_IDLE_SEC) {
      lines.push(
        `WARNING: flusher heartbeat is ${heartbeatAge}s stale — the daemon may not be running`,
      );
    }
  }

  // In inline mode there is no flusher daemon to report on; the "last flush"
  // and "last error" lines above reflect inline attempts instead.
  if (shipMode === 'daemon' && flusherRunning !== null) {
    lines.push(`flusher:     ${flusherRunning}`);
  }
  if (shipperRunning !== null) {
    lines.push(`shipper:     ${shipperRunning}`);
  }

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
