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
