import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collateDirectory,
  collatedDir,
  collatedPathFor,
  discardCollated,
} from './transcript-collate';

describe('collateDirectory', () => {
  let src: string;
  let telHome: string;

  function write(relPath: string, value: unknown): void {
    const full = join(src, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, JSON.stringify(value), 'utf8');
  }

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'collate-src-'));
    telHome = mkdtempSync(join(tmpdir(), 'collate-tel-'));
    process.env.CLAUDE_TELEMETRY_HOME = telHome;
  });

  afterEach(() => {
    rmSync(src, { force: true, recursive: true });
    rmSync(telHome, { force: true, recursive: true });
    delete process.env.CLAUDE_TELEMETRY_HOME;
  });

  it('collates a directory of per-message JSON into one JSONL', () => {
    write('message/msg_2.json', { id: 'msg_2', role: 'assistant', time: { created: 200 } });
    write('message/msg_1.json', { id: 'msg_1', role: 'user', time: { created: 100 } });

    const dest = collatedPathFor('sess-1');
    expect(collateDirectory(src, dest)).toBe(2);

    const lines = readFileSync(dest, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe('msg_1');
    expect(JSON.parse(lines[1] as string).id).toBe('msg_2');
  });

  it('orders by record timestamp, not by directory listing order', () => {
    // Names sort the wrong way round on purpose.
    write('a.json', { id: 'late', timestamp: '2026-08-13T12:00:00Z' });
    write('z.json', { id: 'early', timestamp: '2026-08-13T09:00:00Z' });

    const dest = collatedPathFor('sess-2');
    collateDirectory(src, dest);
    const ids = readFileSync(dest, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['early', 'late']);
  });

  it('is deterministic for records with no timestamp (falls back to path order)', () => {
    write('b.json', { id: 'b' });
    write('a.json', { id: 'a' });

    const first = collatedPathFor('sess-3a');
    const second = collatedPathFor('sess-3b');
    collateDirectory(src, first);
    collateDirectory(src, second);
    expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'));
  });

  it('recurses into nested directories and expands nested .jsonl files', () => {
    write('parts/p1.json', { id: 'p1', time: { created: 1 } });
    mkdirSync(join(src, 'stream'), { recursive: true });
    writeFileSync(
      join(src, 'stream', 'chunks.jsonl'),
      `${JSON.stringify({ id: 'c1', time: { created: 2 } })}\n${JSON.stringify({ id: 'c2', time: { created: 3 } })}\n`,
      'utf8',
    );

    const dest = collatedPathFor('sess-4');
    expect(collateDirectory(src, dest)).toBe(3);
  });

  it('skips unparseable records rather than shipping garbage', () => {
    write('good.json', { id: 'good' });
    writeFileSync(join(src, 'bad.json'), 'not json at all', 'utf8');

    const dest = collatedPathFor('sess-5');
    expect(collateDirectory(src, dest)).toBe(1);
    expect(readFileSync(dest, 'utf8')).toContain('good');
  });

  it('writes nothing for an empty or record-less directory', () => {
    const dest = collatedPathFor('sess-6');
    expect(collateDirectory(src, dest)).toBe(0);
    expect(() => readFileSync(dest, 'utf8')).toThrow();
  });

  it('stages only under the telemetry home, never inside the agent storage', () => {
    const dest = collatedPathFor('sess-7');
    expect(dest.startsWith(telHome)).toBe(true);
    expect(dest.startsWith(src)).toBe(false);
  });

  it('discards a staged collation, and refuses to delete anything outside staging', () => {
    write('m.json', { id: 'm' });
    const dest = collatedPathFor('sess-8');
    collateDirectory(src, dest);
    discardCollated(dest);
    expect(() => readFileSync(dest, 'utf8')).toThrow();

    // A path outside the staging dir is left alone even if asked.
    const outside = join(src, 'm.json');
    discardCollated(outside);
    expect(readFileSync(outside, 'utf8')).toContain('"m"');
    expect(collatedDir().startsWith(telHome)).toBe(true);
  });
});
