import { homedir } from 'node:os';

export function telemetryHome(): string {
  return process.env.CLAUDE_TELEMETRY_HOME ?? `${homedir()}/.claude-telemetry`;
}

export function queuePath(): string {
  return `${telemetryHome()}/queue.db`;
}

export function identityPath(): string {
  return `${telemetryHome()}/identity.json`;
}

export function pausedPath(): string {
  return `${telemetryHome()}/paused`;
}

export function shipQueueDir(): string {
  return `${telemetryHome()}/ship-queue`;
}

/**
 * Root for per-adapter working state (codex's rollout cursors, gemini's token
 * accumulators). ONE directory so shared commands never name an agent: `purge`
 * removes this whole tree, and the next adapter that needs state inherits that
 * for free instead of being remembered — or forgotten, which is what left
 * unredacted per-session state behind the first time.
 */
export function agentStateRoot(): string {
  return `${telemetryHome()}/agent-state`;
}

/** Per-agent subdirectory under {@link agentStateRoot}. */
export function agentStateDir(agentType: string): string {
  return `${agentStateRoot()}/${agentType.toLowerCase()}`;
}

export function flusherStatePath(): string {
  return `${telemetryHome()}/flusher-state.json`;
}
