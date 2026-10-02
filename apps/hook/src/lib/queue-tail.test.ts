import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue, type QueuedEvent } from './queue';
import { readLinesWindow } from './tail-read';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-queue-tail-'));
  process.env.AIOT_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.AIOT_QUEUE_MAX_EVENTS;
  delete process.env.AIOT_QUEUE_MAX_BYTES;
});

const id = (i: number) => `01939f6c-1234-7000-8000-${i.toString().padStart(12, '0')}`;
/** ~824 bytes, the size of a real Stop row (an 8-byte payload hides what a transaction costs). */
const rowFor = (i: number): QueuedEvent => ({
  event_id: id(i),
  payload_json: JSON.stringify({
    agent_type: 'CLAUDE_CODE',
    event_id: id(i),
    event_type: 'Stop',
    metadata: {
      source: 'claude-jsonl',
      transcript_path: `/home/dev/.claude/projects/${'p'.repeat(60)}`,
    },
    pad: 'x'.repeat(560),
    session_id: '3f8c2a1e-9d47-4b6a-8c25-1e7f0a9b4d63',
    ts: new Date(Date.UTC(2026, 4, 21, 12, 0, 0) + i * 1000).toISOString(),
  }),
  ts: new Date(Date.UTC(2026, 4, 21, 12, 0, 0) + i * 1000).toISOString(),
});

function count(): number {
  const db = new Database(join(tmpHome, 'queue.db'));
  try {
    return db.query<{ c: number }, []>('SELECT count(*) AS c FROM events_queue').get()?.c ?? -1;
  } finally {
    db.close();
  }
}

describe('enqueueMany', () => {
  it('adds every row, deduplicates on event_id, and accepts an empty batch', () => {
    const q = openQueue();
    q.enqueue(rowFor(1));
    expect(q.enqueueMany([rowFor(0), rowFor(1), rowFor(2)])).toBe(true);
    expect(q.enqueueMany([])).toBe(true);
    q.close();
    expect(count()).toBe(3);
  });

  it('never prunes: rows that do not fit are refused whole, and the queue is untouched', () => {
    process.env.AIOT_QUEUE_MAX_EVENTS = '1000';
    const q = openQueue();
    expect(q.enqueueMany(Array.from({ length: 900 }, (_, i) => rowFor(i)))).toBe(true);
    // 900 + 200 > 1000: pruning would delete the OLDEST rows by ts, which for a
    // transcript tail are the rows just inserted. Nothing is inserted instead.
    expect(q.enqueueMany(Array.from({ length: 200 }, (_, i) => rowFor(10_000 + i)))).toBe(false);
    expect(count()).toBe(900);
    expect(q.enqueueMany(Array.from({ length: 100 }, (_, i) => rowFor(20_000 + i)))).toBe(true);
    q.close();
    expect(count()).toBe(1000);
  });

  it('refuses when the queue file is already over the byte cap', () => {
    const q = openQueue();
    q.enqueueMany(Array.from({ length: 200 }, (_, i) => rowFor(i)));
    q.close();
    process.env.AIOT_QUEUE_MAX_BYTES = '1000';
    const again = openQueue();
    expect(again.enqueueMany([rowFor(5_000)])).toBe(false);
    again.close();
    expect(count()).toBe(200);
  });

  it('a throwing row leaves none of its chunk behind', () => {
    const q = openQueue();
    q.enqueue(rowFor(100));
    const poisoned = [rowFor(0), rowFor(1), { ...rowFor(2), ts: {} as unknown as string }];
    expect(() => q.enqueueMany(poisoned)).toThrow();
    q.close();
    expect(count()).toBe(1);
  });

  it('a 500-row chunk of realistic rows stays well inside the 100 ms busy timeout', () => {
    const q = openQueue();
    const rows = Array.from({ length: 500 }, (_, i) => rowFor(i));
    expect(rows[0]?.payload_json.length).toBeGreaterThan(780);
    const t0 = performance.now();
    q.enqueueMany(rows);
    const ms = performance.now() - t0;
    q.close();
    expect(count()).toBe(500);
    expect(ms).toBeLessThan(50); // ~5 ms measured; a 10,000-row transaction is >100 ms
  });
});

describe('readLinesWindow', () => {
  const file = () => join(tmpHome, 't.jsonl');

  it('returns whole non-blank lines with the byte offset just past each newline', () => {
    const text = '{"a":1}\n\n{"b":"日本語"}\n{"c":3}\n{"half":';
    writeFileSync(file(), text);
    const { lines, newOffset } = readLinesWindow(file(), 0, 1024);
    expect(lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":"日本語"}', '{"c":3}']);
    const end = (s: string) => Buffer.byteLength(text.slice(0, text.indexOf(s) + s.length + 1));
    expect(lines.map((l) => l.end)).toEqual([end('{"a":1}'), end('"日本語"}'), end('{"c":3}')]);
    expect(newOffset).toBe(Buffer.byteLength('{"a":1}\n\n{"b":"日本語"}\n{"c":3}\n'));
  });

  it('works in windows: no line is split or skipped, and a long line widens the window', () => {
    const long = `{"big":"${'z'.repeat(5000)}"}`;
    const text = `{"a":1}\n${long}\n{"c":3}\n`;
    writeFileSync(file(), text);
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const { lines, newOffset } = readLinesWindow(file(), offset, 16); // far below one line
      if (newOffset === offset) {
        break;
      }
      seen.push(...lines.map((l) => l.text));
      offset = newOffset;
    }
    expect(seen).toEqual(['{"a":1}', long, '{"c":3}']);
    expect(offset).toBe(Buffer.byteLength(text));
  });

  it('a file that shrank after the stat is the end of the file, not an endless widening', () => {
    // 8 bytes with no newline, while the stat (taken before the file was truncated or
    // replaced) still says 100,000: every read is short. It used to double the window
    // and read again for ever.
    writeFileSync(file(), '{"half":');
    const stat = spyOn(fs, 'statSync').mockImplementation((() => ({ size: 100_000 })) as never);
    const realRead = fs.readSync;
    let reads = 0;
    const read = spyOn(fs, 'readSync').mockImplementation(((
      ...args: Parameters<typeof realRead>
    ) => {
      reads += 1;
      if (reads > 20) {
        throw new Error('readLinesWindow looped');
      }
      return realRead(...args);
    }) as never);
    try {
      expect(readLinesWindow(file(), 0, 64)).toEqual({ lines: [], newOffset: 0 });
      expect(reads).toBe(1);
    } finally {
      stat.mockRestore();
      read.mockRestore();
    }
  });

  it('a file with nothing new, or only a half-written line, moves nothing', () => {
    writeFileSync(file(), '{"half":');
    expect(readLinesWindow(file(), 0, 1024)).toEqual({ lines: [], newOffset: 0 });
    expect(readLinesWindow(file(), 8, 1024)).toEqual({ lines: [], newOffset: 8 });
  });
});
