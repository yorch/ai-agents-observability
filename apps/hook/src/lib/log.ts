import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { telemetryHome } from './paths.js';

const LOG_PATH = `${telemetryHome()}/hook.log`;

let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) {
    return;
  }
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    dirEnsured = true;
  } catch {
    // Swallow — log() must never throw.
  }
}

export function log(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
  ensureDir();
  const line = `${JSON.stringify({ event, level, ts: new Date().toISOString(), ...fields })}\n`;
  try {
    appendFileSync(LOG_PATH, line, { encoding: 'utf8' });
  } catch {
    // Swallow — log() must never throw.
  }
}

export function logPath(): string {
  return LOG_PATH;
}
