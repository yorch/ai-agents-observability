import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log, logPath } from './log';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'claude-tel-log-test-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.CLAUDE_TELEMETRY_HOME;
});

describe('log', () => {
  it('appends one JSON line per call with event, level and ts', () => {
    log('info', 'first', { a: 1 });
    log('warn', 'second');

    const lines = readFileSync(logPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] as string);
    expect(first).toMatchObject({ a: 1, event: 'first', level: 'info' });
    expect(typeof first.ts).toBe('string');

    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: 'second', level: 'warn' });
  });

  it('rotates to <path>.1 once the log exceeds the size threshold', () => {
    const path = logPath();
    // Seed an oversized active log (> 5 MiB) so the next write triggers rotation.
    writeFileSync(path, 'x'.repeat(6 * 1024 * 1024));

    log('info', 'after-rotate');

    expect(existsSync(`${path}.1`)).toBe(true);
    // The active log now holds only the post-rotation line.
    const active = readFileSync(path, 'utf8').trim().split('\n');
    expect(active).toHaveLength(1);
    expect(JSON.parse(active[0] as string)).toMatchObject({ event: 'after-rotate' });
    // The pre-rotation content was preserved in the backup, not lost.
    expect(statSync(`${path}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('never throws even when the log directory cannot be created', () => {
    // Point the home at a path whose parent is a file, so mkdir/append fail.
    const blocker = join(tmpHome, 'blocker');
    writeFileSync(blocker, 'not-a-dir');
    process.env.CLAUDE_TELEMETRY_HOME = join(blocker, 'nested');

    expect(() => log('error', 'boom')).not.toThrow();
  });
});
