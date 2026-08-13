import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { telemetryHome } from './paths';

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
  return join(collatedDir(), `${sessionId}.jsonl`);
}

function collectJson(dir: string, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectJson(full, out, depth + 1);
    } else if (name.endsWith('.json') || name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

function timeOf(record: unknown): number {
  if (typeof record !== 'object' || record === null) {
    return 0;
  }
  const r = record as Record<string, unknown>;
  const time = r.time;
  const candidates = [
    typeof time === 'object' && time !== null ? (time as Record<string, unknown>).created : null,
    r.created,
    r.timestamp,
    r.createdAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
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

  const records: { order: number; path: string; text: string }[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // A .json file is one record; a .jsonl file inside the directory is many.
    const lines = file.endsWith('.jsonl')
      ? text.split('\n').filter((line) => line.trim().length > 0)
      : [text];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // skip unparseable records rather than shipping garbage
      }
      records.push({ order: timeOf(parsed), path: file, text: JSON.stringify(parsed) });
    }
  }
  if (records.length === 0) {
    return 0;
  }

  records.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  mkdirSync(join(destPath, '..'), { recursive: true });
  writeFileSync(destPath, `${records.map((r) => r.text).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return records.length;
}

/** Remove a staged collation. Safe to call for paths that were never staged. */
export function discardCollated(path: string): void {
  if (!path.startsWith(collatedDir())) {
    return; // never delete anything outside our own staging area
  }
  rmSync(path, { force: true });
}
