import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { telemetryHome } from './paths';

// Path is computed per call rather than at module load so overrides set after
// import (test setup, bench script) take effect.
export function logPath(): string {
  return `${telemetryHome()}/hook.log`;
}

const ensuredDirs = new Set<string>();

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (ensuredDirs.has(dir)) {
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  } catch {
    // Swallow — log() must never throw.
  }
}

export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
): void {
  const path = logPath();
  ensureDir(path);
  const line = `${JSON.stringify({ event, level, ts: new Date().toISOString(), ...fields })}\n`;
  try {
    appendFileSync(path, line, { encoding: 'utf8' });
  } catch {
    // Swallow — log() must never throw.
  }
}
