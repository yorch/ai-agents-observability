import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { telemetryHome } from './paths';

// Rotate once the active log passes this size, keeping a single previous
// generation (`hook.log.1`). The hook ships as a dependency-free single binary,
// so we do simple size-based rotation here rather than pulling in pino-roll.
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB

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

// Rename the active log to `<path>.1` (overwriting any prior backup) once it
// grows past MAX_LOG_BYTES, so the on-disk footprint stays bounded.
function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size >= MAX_LOG_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // Missing file (first write) or a rotation race — ignore; log() must never throw.
  }
}

export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
): void {
  const path = logPath();
  ensureDir(path);
  rotateIfLarge(path);
  const line = `${JSON.stringify({ event, level, ts: new Date().toISOString(), ...fields })}\n`;
  try {
    appendFileSync(path, line, { encoding: 'utf8' });
  } catch {
    // Swallow — log() must never throw.
  }
}
