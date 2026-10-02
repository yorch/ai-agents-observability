import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Read only the bytes an append-only JSONL file has grown by since `fromOffset`.
 *
 * Two adapters need this and for the same reason: their agent's per-turn signal
 * fires once per turn while the data it needs lives in a file that only grows, so
 * re-reading the whole file every turn is O(n²) over a session. Codex (rollout
 * JSONL) had it first; the Claude Code Stop path needs exactly the same read, and
 * a second copy is how `isRecord`/`pickString` drifted into disagreeing versions
 * before (see apps/hook/AGENTS.md).
 *
 * Returns whole lines only: the read stops at the last newline, so a half-written
 * final line is left for the next call rather than parsed as truncated JSON.
 * Throws if the file is missing or unreadable — callers degrade, they do not
 * propagate (the hook must always exit 0).
 */
export function readNewLines(
  path: string,
  fromOffset: number,
): { lines: string[]; newOffset: number } {
  const size = statSync(path).size;
  if (size <= fromOffset) {
    return { lines: [], newOffset: fromOffset };
  }
  const len = size - fromOffset;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromOffset);
  } finally {
    closeSync(fd);
  }
  const slice = buf.toString('utf8');
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl < 0) {
    return { lines: [], newOffset: fromOffset };
  }
  const consumed = slice.slice(0, lastNl + 1);
  const lines = consumed.split('\n').filter((l) => l.trim().length > 0);
  return { lines, newOffset: fromOffset + Buffer.byteLength(consumed, 'utf8') };
}

/** JSON.parse that yields null instead of throwing on a malformed line. */
export function safeJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** One non-blank line and the byte offset just past its newline. */
export type OffsetLine = { text: string; end: number };

/**
 * Like {@link readNewLines}, but at most about `maxBytes` per call and with each
 * line's end offset, so a caller that stops part-way can record a cursor that
 * points exactly past the last line it finished. A line longer than the window
 * widens it (a tool result can be megabytes) rather than being split. Whole lines
 * only; `newOffset` is just past the last newline read.
 */
export function readLinesWindow(
  path: string,
  fromOffset: number,
  maxBytes: number,
): { lines: OffsetLine[]; newOffset: number } {
  const size = statSync(path).size;
  let len = Math.min(size - fromOffset, maxBytes);
  if (len <= 0) {
    return { lines: [], newOffset: fromOffset };
  }
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(len);
      const got = readSync(fd, buf, 0, len, fromOffset);
      const lastNl = buf.subarray(0, got).lastIndexOf(10);
      if (lastNl < 0) {
        // A half-written final line, or the file shrank or was replaced after the stat
        // (a short read): either way there is nothing whole to return. Widening the
        // window only makes sense while the file really is longer than what we asked for.
        if (got < len || fromOffset + got >= size) {
          return { lines: [], newOffset: fromOffset };
        }
        len = Math.min(size - fromOffset, len * 2);
        continue;
      }
      const lines: OffsetLine[] = [];
      let start = 0;
      while (start <= lastNl) {
        const nl = buf.indexOf(10, start);
        const text = buf.toString('utf8', start, nl);
        if (text.trim().length > 0) {
          lines.push({ end: fromOffset + nl + 1, text });
        }
        start = nl + 1;
      }
      return { lines, newOffset: fromOffset + lastNl + 1 };
    }
  } finally {
    closeSync(fd);
  }
}
