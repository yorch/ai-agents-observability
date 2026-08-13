import {
  closeSync,
  type Dirent,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { telemetryHome } from './paths';
import { isSessionUuid } from './session-id';

// Directory-shaped transcripts → one JSONL file (P12-009).
//
// The shipper reads a single file. Most agents oblige: Claude Code, Codex, Pi and
// omp all store one session as one JSONL. opencode does not — its history is a
// directory of per-message JSON — which is why opencode has had no transcript
// upload since P8-004.
//
// Rather than teach the shipper about directories (and about opencode), the rule
// here is agent-neutral: **a transcript target that is a directory gets collated
// into a single file first**. The collated file is a temp artifact under the
// telemetry home — never written inside the agent's own storage — and is deleted
// once the upload finishes.

const MAX_DEPTH = 4;

/** Where collated transcripts are staged. Ours, not the agent's. */
export function collatedDir(): string {
  return join(telemetryHome(), 'collated');
}

export function collatedPathFor(sessionId: string): string {
  // Session ids reach here already normalized (lib/session-id.ts), so anything
  // else is a bug upstream — reject rather than interpolate, since `join()` would
  // happily normalize `../../x` straight out of the staging directory.
  if (!isSessionUuid(sessionId)) {
    throw new Error(`refusing to stage a collation for a non-UUID session id: ${sessionId}`);
  }
  return join(collatedDir(), `${sessionId}.jsonl`);
}

function collectJson(dir: string, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sorted for a deterministic transcript; symlinks skipped so a link inside the
  // agent's storage cannot pull ~/.ssh (or any other tree) into what we ship.
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJson(full, out, depth + 1);
    } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/**
 * A record's timestamp in milliseconds, or null when it has none.
 *
 * Seconds-epoch values are scaled to milliseconds: a directory mixing the two
 * would otherwise sort every seconds-stamped record (~1.7e9) before every
 * ms-stamped one (~1.7e12), inverting the conversation.
 *
 * SEAM NOTE: the candidate list below is opencode's record shape, which is the
 * only directory-shaped agent we capture. If a second one lands, do NOT lengthen
 * this list — that turns an agent-neutral rule into a hidden per-agent switch.
 * Have the adapter supply the ordering key instead (an optional `orderBy` on
 * `TranscriptTarget`, or a parameter here).
 */
function timeOf(record: unknown): number | null {
  if (typeof record !== 'object' || record === null) {
    return null;
  }
  const r = record as Record<string, unknown>;
  const time = r.time;
  const candidates = [
    typeof time === 'object' && time !== null ? (time as Record<string, unknown>).created : null,
    typeof time === 'string' || typeof time === 'number' ? time : null,
    r.created,
    r.timestamp,
    r.createdAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      // Anything below ~2001 in ms is really a seconds-epoch value.
      return candidate < 1e11 ? candidate * 1000 : candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Collate every JSON record under `dir` into one JSONL file at `destPath`.
 *
 * Ordering is deterministic and conversation-shaped: by the record's own
 * timestamp where it has one, then by file path — so a directory listing that
 * comes back in arbitrary order still produces the same transcript every time.
 *
 * Returns the number of records written; 0 means nothing usable was found and
 * the destination is not created.
 */
export function collateDirectory(dir: string, destPath: string): number {
  const files: string[] = [];
  collectJson(dir, files);
  if (files.length === 0) {
    return 0;
  }

  // Only the ORDERING KEYS are held in memory — never the record bodies. A busy
  // opencode session's history runs to hundreds of MB; buffering it (parsed, then
  // re-serialized, then joined into one string) would spike the shipper's RSS to
  // several times that and can exceed the engine's max string length outright.
  type Ref = { file: string; line: number; order: number | null; seq: number };
  const refs: Ref[] = [];
  let seq = 0;
  for (const file of files) {
    for (const [index, line] of readRecordLines(file).entries()) {
      const parsed = safeParse(line);
      if (parsed === undefined) {
        continue; // skip unparseable records rather than shipping garbage
      }
      refs.push({ file, line: index, order: timeOf(parsed), seq: seq++ });
    }
  }
  if (refs.length === 0) {
    return 0;
  }

  // Timestamped records first, in time order; untimed records keep discovery
  // order and follow, rather than being flung to the top of the conversation by a
  // zero sentinel. Ties break on discovery order, so the output is byte-stable.
  refs.sort((a, b) => {
    if (a.order !== null && b.order !== null) {
      return a.order - b.order || a.seq - b.seq;
    }
    if (a.order !== null) {
      return -1;
    }
    if (b.order !== null) {
      return 1;
    }
    return a.seq - b.seq;
  });

  mkdirSync(dirname(destPath), { mode: 0o700, recursive: true });
  const fd = openSync(destPath, 'w', 0o600);
  try {
    // Group by file so each source is read at most once more, streaming out.
    const byFile = new Map<string, Ref[]>();
    for (const ref of refs) {
      const list = byFile.get(ref.file) ?? [];
      list.push(ref);
      byFile.set(ref.file, list);
    }
    const linesByFile = new Map<string, string[]>();
    for (const file of byFile.keys()) {
      linesByFile.set(file, readRecordLines(file));
    }
    for (const ref of refs) {
      const line = linesByFile.get(ref.file)?.[ref.line];
      if (line === undefined) {
        continue;
      }
      const parsed = safeParse(line);
      if (parsed === undefined) {
        continue;
      }
      writeSync(fd, `${JSON.stringify(parsed)}\n`);
    }
  } finally {
    closeSync(fd);
  }
  return refs.length;
}

/** A `.json` file is one record; a `.jsonl` inside the directory is many. */
function readRecordLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return file.endsWith('.jsonl')
    ? text.split('\n').filter((line) => line.trim().length > 0)
    : [text];
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Remove a staged collation. Safe to call for paths that were never staged. */
export function discardCollated(path: string): void {
  // The separator matters: a bare prefix test also matches sibling paths like
  // `<home>/collated-backup/x.jsonl`, which we must never delete.
  if (!path.startsWith(`${collatedDir()}${sep}`)) {
    return;
  }
  rmSync(path, { force: true });
}

/**
 * Delete every staged collation. Called at shipper start and by `purge-local`:
 * a staging file is a PLAINTEXT, UNREDACTED copy of the agent's history
 * (redaction happens later, during the upload stream), so one left behind by a
 * killed shipper must not linger — and "delete all local telemetry data" has to
 * mean it.
 */
export function purgeCollated(): void {
  rmSync(collatedDir(), { force: true, recursive: true });
}
