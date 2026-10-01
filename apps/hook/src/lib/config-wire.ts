// Shared helpers for adapter detect/apply/remove implementations.
// These handle the common patterns: config-dir detection, backup creation,
// and JSON merge with ownership-marker-based idempotency.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';

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
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
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
 * Replace a file's contents atomically: write a sibling temp file, then rename.
 *
 * These helpers rewrite config files WE DO NOT OWN — `~/.claude/settings.json`
 * and its equivalents for the other agents. A bare `writeFileSync` truncates
 * first, so a crash or a full disk mid-write leaves the user with a half-written
 * settings file that their agent then refuses to parse: we would have broken a
 * tool the hook is only supposed to observe. `rename` within a directory is
 * atomic, so a reader sees either the old file or the new one.
 *
 * The `.aiot-backup` companion exists for a corrupted file, but recovering from
 * it is manual — not being the cause is better. `shipper.ts` already uses this
 * idiom for its markers.
 */
function writeFileAtomic(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.aiot-tmp`;
  writeFileSync(tmpPath, contents, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Write JSON to a file with pretty-printing (2-space indent). Creates parent
 * directories as needed. Atomic — see {@link writeFileAtomic}.
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Write a text file. Creates parent directories as needed. Atomic — see
 * {@link writeFileAtomic}.
 */
export function writeTextFile(filePath: string, content: string): void {
  writeFileAtomic(filePath, content);
}

/** `aiot` (the launcher), `aiot-<target>`, or `aiot-runtime[-<target>]`. */
const AIOT_BASENAME = /^aiot(-.+)?$/;

/**
 * Is `exe` (a path) the compiled aiot launcher or runtime? ONE predicate for two
 * questions that must never disagree: "may install write this path into an agent
 * config" (install.ts) and "will re-install/uninstall recognise it afterwards"
 * (ownership below). A name accepted by one and rejected by the other (`aiot2`)
 * writes hooks nothing can ever clean up.
 */
export function isAiotBinary(exe: string): boolean {
  return AIOT_BASENAME.test(basename(exe));
}

/**
 * Hook kinds aiot has ever registered (Claude Code and Codex). The legacy
 * `bun hook <kind>` rule only fires for these. A test derives the kinds from a
 * real apply and fails if one is missing here.
 */
const KNOWN_HOOK_KINDS: ReadonlySet<string> = new Set([
  'notification',
  'permission-request',
  'post-tool-use',
  'pre-compact',
  'pre-tool-use',
  'session-end',
  'session-start',
  'stop',
  'subagent-stop',
  'user-prompt-submit',
]);

/**
 * Split a shell-ish command string into tokens, honouring "double" and 'single'
 * quotes. Only used for hook shapes that put the whole invocation in one string
 * (Gemini CLI writes `"<bin>" hook <kind> --agent gemini-cli`).
 */
function splitCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * True when `argv` (executable first) is an invocation aiot wrote: the
 * executable's BASENAME is the launcher/runtime and the first argument is
 * `hook`. A path that merely contains "aiot" (`/aiot-tools/x`) does not match.
 */
function isAiotInvocation(argv: readonly unknown[]): boolean {
  const [exe, sub] = argv;
  return typeof exe === 'string' && sub === 'hook' && isAiotBinary(exe);
}

/**
 * LEGACY: the exact entries that leaked into real configs when install ran from
 * the Bun runtime (tests, `bun run src/cli.ts`) — six more per run — before hook
 * wiring was refused outside the compiled binary:
 *
 *   Claude: `{ args: ['hook', <kind>], command: <abs path>/bun, type }`
 *   Codex:  `{ command: [<abs path>/bun, 'hook', <kind>, '--agent', <name>], type }`
 *
 * Deliberately narrow so re-install/uninstall can repair them without touching a
 * user's own `bun run lint`: an ABSOLUTE `bun` path, a known hook kind, the
 * args-array form for Claude (a plain `"bun hook stop"` string is not ours), no
 * extra keys, and (checked by the caller) no matcher on the group.
 *
 * RESIDUAL RISK, accepted: a developer's own hook that is exactly an absolute-path
 * `bun hook <known-kind>` with no matcher/timeout is indistinguishable from the
 * leak and WILL be treated as ours — removed on uninstall, replaced on install.
 */
function isLegacyBunHook(h: Record<string, unknown>): boolean {
  if (typeof h.command === 'string') {
    const args = h.args;
    return (
      Array.isArray(args) &&
      args.length === 2 &&
      args[0] === 'hook' &&
      typeof args[1] === 'string' &&
      KNOWN_HOOK_KINDS.has(args[1]) &&
      isAbsolute(h.command) &&
      basename(h.command) === 'bun' &&
      onlyKeys(h, ['args', 'command', 'type'])
    );
  }
  const c = h.command;
  return (
    Array.isArray(c) &&
    c.length === 5 &&
    typeof c[0] === 'string' &&
    isAbsolute(c[0]) &&
    basename(c[0]) === 'bun' &&
    c[1] === 'hook' &&
    typeof c[2] === 'string' &&
    KNOWN_HOOK_KINDS.has(c[2]) &&
    c[3] === '--agent' &&
    typeof c[4] === 'string' &&
    onlyKeys(h, ['command', 'type'])
  );
}

/** True when every own key of `o` is in `allowed`. */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/**
 * Is this hook object (one element of a group's `hooks` array, or a Codex entry
 * itself) one aiot wrote? `plainGroup` says the enclosing group has no keys
 * besides `hooks` (no matcher), which {@link isLegacyBunHook} requires.
 */
function isOwnedHook(h: Record<string, unknown>, plainGroup: boolean): boolean {
  // Gemini names every entry `aiot-<kind>`.
  if (typeof h.name === 'string' && h.name.startsWith('aiot-')) {
    return true;
  }
  let argv: unknown[];
  if (typeof h.command === 'string') {
    // Claude: command + args[]. Gemini: the whole invocation in `command`.
    argv = Array.isArray(h.args) ? [h.command, ...h.args] : splitCommand(h.command);
  } else if (Array.isArray(h.command)) {
    argv = h.command; // Codex / Copilot
  } else {
    return false;
  }
  return isAiotInvocation(argv) || (plainGroup && isLegacyBunHook(h));
}

/**
 * Strip aiot-owned hooks from a hooks array. Works for both the Claude Code /
 * Gemini CLI shape (entries with `hooks` arrays of `{ command, args, type }`)
 * and the Codex shape (entries that are `{ command: string[], type }`).
 *
 * Ownership is structural — see {@link isOwnedHook} — never a substring test:
 * `command.includes('aiot')` missed `bun hook` (so every re-install appended
 * another group) while matching any foreign path that contained "aiot".
 * Everything else, including the rest of a mixed group, is preserved verbatim.
 */
export function stripOwnedEntries(entries: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const entry of entries) {
    const stripped = stripEntry(entry);
    if (stripped !== null) {
      result.push(stripped);
    }
  }
  return result;
}

/**
 * Strip aiot-owned hooks from a single entry. Returns the cleaned entry
 * (which may be the original if nothing was owned), or null if the entire
 * entry was aiot-owned and should be removed.
 */
function stripEntry(entry: unknown): unknown | null {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }
  const e = entry as Record<string, unknown>;

  // Claude Code / Gemini shape: { hooks: [{ command, args, name? }] }
  // Filter the nested hooks array rather than removing the whole group —
  // a user may have their own hooks in the same group.
  if (Array.isArray(e.hooks)) {
    const plainGroup = onlyKeys(e, ['hooks']);
    const filtered = e.hooks.filter(
      (h) =>
        !(
          typeof h === 'object' &&
          h !== null &&
          isOwnedHook(h as Record<string, unknown>, plainGroup)
        ),
    );
    if (filtered.length === e.hooks.length) {
      return entry;
    }
    if (filtered.length === 0) {
      // The entire group was aiot-owned.
      return null;
    }
    return { ...e, hooks: filtered };
  }

  // Codex / Copilot shape: { command: string[] }
  if (Array.isArray(e.command)) {
    return isOwnedHook(e, true) ? null : entry;
  }

  return entry;
}
