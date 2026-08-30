// Shared helpers for adapter detect/apply/remove implementations.
// These handle the common patterns: config-dir detection, backup creation,
// and JSON merge with ownership-marker-based idempotency.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

/** Suffix appended to config files before aiot's first modification. */
export const BACKUP_SUFFIX = '.aiot-backup';

/**
 * Resolve the user's home directory. Prefers `process.env.HOME` (which can be
 * overridden in tests) and falls back to `os.homedir()` (which caches the
 * system value and ignores later `HOME` changes).
 */
export function homeDir(): string {
  return process.env.HOME ?? homedir();
}

/**
 * True if a directory exists at `path`. Used by `detect()` implementations.
 * Checks for the directory, not a specific file — the agent may not have
 * created any config files yet, but the directory's presence means the agent
 * was installed and run at least once.
 */
export function dirExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Create a `.aiot-backup` copy of `filePath` if it exists and no backup
 * already exists. Called before the first modification of a user-owned config
 * file. Does nothing if the file doesn't exist (nothing to back up) or if a
 * backup already exists (don't overwrite a prior backup).
 */
export function createBackupIfAbsent(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const backup = `${filePath}${BACKUP_SUFFIX}`;
  if (existsSync(backup)) {
    return;
  }
  copyFileSync(filePath, backup);
}

/**
 * Remove the `.aiot-backup` file for `filePath` if it exists. Called after
 * a successful `remove()` — once our entries are stripped and the file is
 * back to its original state, the backup is no longer needed.
 */
export function removeBackup(filePath: string): void {
  const backup = `${filePath}${BACKUP_SUFFIX}`;
  if (existsSync(backup)) {
    rmSync(backup, { force: true });
  }
}

/**
 * Read and parse a JSON file. Returns `null` if the file doesn't exist.
 * Throws if the file exists but cannot be parsed — callers must catch this
 * and refuse to overwrite a corrupt user file rather than clobbering it.
 */
export function readJsonFile<T = Record<string, unknown>>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const text = readFileSync(filePath, 'utf8');
  return JSON.parse(text) as T;
}

/**
 * Write JSON to a file with pretty-printing (2-space indent). Creates parent
 * directories as needed.
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Write a text file. Creates parent directories as needed.
 */
export function writeTextFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

/**
 * Strip entries from a hooks array whose command references our ownership
 * marker. Works for both the Claude Code / Gemini CLI shape (entries with
 * `hooks` arrays containing `{ command, args, type }` objects) and the Codex
 * shape (entries with `{ command: string[], type }` objects).
 *
 * The marker is a substring that uniquely identifies aiot-owned entries —
 * typically the binary name or a wrapper script name. User hooks that don't
 * contain the marker are preserved.
 */
export function stripOwnedEntries(entries: unknown[], marker: string): unknown[] {
  return entries.filter((entry) => !entryReferencesMarker(entry, marker));
}

/**
 * Check whether a hook entry references the ownership marker in any of its
 * command fields. Handles both string commands and argv-array commands.
 */
function entryReferencesMarker(entry: unknown, marker: string): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;

  // Claude Code / Gemini shape: { hooks: [{ command: string, args: string[], name?: string }] }
  if (Array.isArray(e.hooks)) {
    return e.hooks.some(
      (h) =>
        typeof h === 'object' &&
        h !== null &&
        ((typeof (h as Record<string, unknown>).command === 'string' &&
          ((h as Record<string, unknown>).command as string).includes(marker)) ||
          (typeof (h as Record<string, unknown>).name === 'string' &&
            ((h as Record<string, unknown>).name as string).includes(marker))),
    );
  }

  // Codex / Copilot shape: { command: string[] }
  if (Array.isArray(e.command)) {
    return e.command.some((c) => typeof c === 'string' && c.includes(marker));
  }

  return false;
}
