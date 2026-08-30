import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collateDirectory,
  collatedDir,
  collatedPathFor,
  discardCollated,
  purgeCollated,
} from './transcript-collate';

const SESSION = (n: number) => `0190abcd-0000-4000-8000-00000000000${n}`;

describe('collateDirectory', () => {
  let src: string;
  let telHome: string;

  function write(relPath: string, value: unknown): void {
    const full = join(src, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, JSON.stringify(value), 'utf8');
  }

  function readIds(path: string): unknown[] {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id);
  }

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'collate-src-'));
    telHome = mkdtempSync(join(tmpdir(), 'collate-tel-'));
    process.env.AIOT_HOME = telHome;
  });

  afterEach(() => {
    rmSync(src, { force: true, recursive: true });
    rmSync(telHome, { force: true, recursive: true });
    delete process.env.AIOT_HOME;
  });

  it('collates a directory of per-message JSON into one JSONL', () => {
    write('message/msg_2.json', { id: 'msg_2', role: 'assistant', time: { created: 200 } });
    write('message/msg_1.json', { id: 'msg_1', role: 'user', time: { created: 100 } });

    const dest = collatedPathFor(SESSION(1));
    expect(collateDirectory(src, dest)).toBe(2);
    expect(readIds(dest)).toEqual(['msg_1', 'msg_2']);
  });

  it('orders by record timestamp, not by directory listing order', () => {
    // Names sort the wrong way round on purpose, so path order alone would fail.
    write('a.json', { id: 'late', timestamp: '2026-08-13T12:00:00Z' });
    write('z.json', { id: 'early', timestamp: '2026-08-13T09:00:00Z' });

    const dest = collatedPathFor(SESSION(2));
    collateDirectory(src, dest);
    expect(readIds(dest)).toEqual(['early', 'late']);
  });

  it('normalizes seconds-epoch against millisecond timestamps', () => {
    // Mixed units in one directory: without scaling, every seconds-stamped
    // record (~1.7e9) sorts before every ms-stamped one (~1.7e12).
    write('a.json', { id: 'first-in-seconds', time: { created: 1_786_000_000 } });
    write('b.json', { id: 'second-in-ms', time: { created: 1_786_000_001_000 } });

    const dest = collatedPathFor(SESSION(3));
    collateDirectory(src, dest);
    expect(readIds(dest)).toEqual(['first-in-seconds', 'second-in-ms']);
  });

  it('keeps untimed records after timed ones, in discovery order', () => {
    // A zero sentinel would fling these to the TOP, ahead of the first real
    // message — the conversation inside-out.
    write('a-untimed.json', { id: 'untimed-1' });
    write('b-timed.json', { id: 'timed', time: { created: 500 } });
    write('c-untimed.json', { id: 'untimed-2' });

    const dest = collatedPathFor(SESSION(4));
    collateDirectory(src, dest);
    expect(readIds(dest)).toEqual(['timed', 'untimed-1', 'untimed-2']);
  });

  it('is byte-stable across runs', () => {
    write('b.json', { id: 'b', time: { created: 2 } });
    write('a.json', { id: 'a', time: { created: 1 } });

    const first = collatedPathFor(SESSION(5));
    const second = collatedPathFor(SESSION(6));
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

    const dest = collatedPathFor(SESSION(7));
    expect(collateDirectory(src, dest)).toBe(3);
    expect(readIds(dest)).toEqual(['p1', 'c1', 'c2']);
  });

  it('does not follow symlinks out of the session directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'collate-outside-'));
    writeFileSync(join(outside, 'secret.json'), JSON.stringify({ id: 'secret' }), 'utf8');
    write('m.json', { id: 'mine', time: { created: 1 } });
    symlinkSync(outside, join(src, 'escape'));

    const dest = collatedPathFor(SESSION(8));
    expect(collateDirectory(src, dest)).toBe(1);
    expect(readIds(dest)).toEqual(['mine']);
    rmSync(outside, { force: true, recursive: true });
  });

  it('skips unparseable records rather than shipping garbage', () => {
    write('good.json', { id: 'good' });
    writeFileSync(join(src, 'bad.json'), 'not json at all', 'utf8');

    const dest = collatedPathFor(SESSION(9));
    expect(collateDirectory(src, dest)).toBe(1);
    expect(readFileSync(dest, 'utf8')).toContain('good');
  });

  it('writes nothing for an empty or record-less directory', () => {
    const dest = collatedPathFor(SESSION(1));
    expect(collateDirectory(src, dest)).toBe(0);
    expect(() => readFileSync(dest, 'utf8')).toThrow();
  });

  it('stages only under the telemetry home, never inside the agent storage', () => {
    const dest = collatedPathFor(SESSION(2));
    expect(dest.startsWith(telHome)).toBe(true);
    expect(dest.startsWith(src)).toBe(false);
  });

  it('refuses to stage under a non-UUID session id', () => {
    // `join()` would normalize a traversal straight out of the staging dir, and
    // the delete guard would then refuse to clean it up.
    expect(() => collatedPathFor('../../escape')).toThrow(/non-UUID/);
    expect(() => collatedPathFor('sess-1')).toThrow(/non-UUID/);
  });

  it('discards a staged collation', () => {
    write('m.json', { id: 'm' });
    const dest = collatedPathFor(SESSION(3));
    collateDirectory(src, dest);
    discardCollated(dest);
    expect(() => readFileSync(dest, 'utf8')).toThrow();
  });

  it('refuses to delete a path outside staging, including a prefix near-miss', () => {
    // A bare prefix test would match this sibling directory and delete it.
    const nearMiss = `${collatedDir()}-backup`;
    mkdirSync(nearMiss, { recursive: true });
    const victim = join(nearMiss, 'keep.jsonl');
    writeFileSync(victim, 'important', 'utf8');
    discardCollated(victim);
    expect(readFileSync(victim, 'utf8')).toBe('important');

    const unrelated = join(src, 'm.json');
    writeFileSync(unrelated, '{"id":"m"}', 'utf8');
    discardCollated(unrelated);
    expect(readFileSync(unrelated, 'utf8')).toContain('"m"');
  });

  it('purges the whole staging directory (it holds unredacted content)', () => {
    write('m.json', { id: 'm' });
    const dest = collatedPathFor(SESSION(4));
    collateDirectory(src, dest);
    purgeCollated();
    expect(() => readFileSync(dest, 'utf8')).toThrow();
  });
});
