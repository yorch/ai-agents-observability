import { existsSync, readFileSync } from 'node:fs';

import type { FlusherStatus } from '../flusher';
import { heartbeatAgeSeconds } from '../flusher';
import { type DrainStatus, readDrainStatus } from '../lib/lease';
import { flusherStatePath, identityPath, pausedPath, queuePath } from '../lib/paths';
import { openQueueReader } from '../lib/queue-reader';
import { pendingMarkerCount } from '../shipper';

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
  if (process.env.AIOT_TOKEN?.trim()) {
    // This is the SHELL's environment. The launchd/systemd services written by
    // `aiot install` do not inherit it, so they still need `aiot login`.
    authLine =
      'AIOT_TOKEN is set in this shell (services installed by `aiot install` do not see it)';
  }

  // ── Paused ────────────────────────────────────────────────────────────────────
  const paused = existsSync(pausedPath());

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
  let oldestQueued: string | null = null;
  let drain: DrainStatus = { holder: null, lastDrainOkAt: null, mode: 'resident' };
  if (existsSync(queuePath())) {
    let reader: ReturnType<typeof openQueueReader> | undefined;
    try {
      reader = openQueueReader(queuePath());
      queueDepth = reader.depth();
      oldestQueued = reader.oldestTs();
      drain = readDrainStatus(reader.db);
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
  if (drain.mode === 'on-demand') {
    process.stdout.write(
      `${onDemandLines({ authLine, drain, flusherState, oldestQueued, paused, queueDepth }).join('\n')}\n`,
    );
    return 0;
  }
  const heartbeatAge = heartbeatAgeSeconds(flusherState.lastHeartbeatAt);
  const lines: string[] = [
    `auth:        ${authLine}`,
    `paused:      ${paused ? 'yes' : 'no'}`,
    'mode:        resident',
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

  if (flusherRunning !== null) {
    lines.push(`flusher:     ${flusherRunning}`);
  }
  if (shipperRunning !== null) {
    lines.push(`shipper:     ${shipperRunning}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) {
    return `${s}s`;
  }
  if (s < 5400) {
    return `${Math.round(s / 60)}m`;
  }
  if (s < 172_800) {
    return `${Math.round(s / 3600)}h`;
  }
  return `${Math.round(s / 86_400)}d`;
}

/**
 * On-demand mode has no daemon, so a heartbeat is meaningless and a stale one
 * would be a false alarm on every healthy idle machine. What matters instead is
 * whether data is getting out: how old the oldest undelivered row is, and when a
 * drain last finished cleanly. A stuck queue stays visible as a growing age.
 */
function onDemandLines(s: {
  authLine: string;
  drain: DrainStatus;
  flusherState: FlusherStatus;
  oldestQueued: string | null;
  paused: boolean;
  queueDepth: number;
}): string[] {
  const now = Date.now();
  const oldest = s.oldestQueued ? Date.parse(s.oldestQueued) : Number.NaN;
  const { holder, lastDrainOkAt } = s.drain;
  return [
    `auth:           ${s.authLine}`,
    `paused:         ${s.paused ? 'yes' : 'no'}`,
    'mode:           on-demand (no resident service; a drainer runs after agent activity)',
    `queue depth:    ${s.queueDepth}`,
    `oldest queued:  ${Number.isNaN(oldest) ? 'none' : `${age(now - oldest)} old (${s.oldestQueued})`}`,
    `transcripts pending: ${pendingMarkerCount()}`,
    `last drain:     ${lastDrainOkAt === null ? 'never' : `${new Date(lastDrainOkAt).toISOString()} (${age(now - lastDrainOkAt)} ago)`}`,
    `drain lease:    ${holder ? `held by pid ${holder.pid} (${holder.role}, ${age(now - holder.startedAt)})` : 'none'}`,
    `last error:     ${s.flusherState.lastError ?? 'none'}`,
  ];
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
