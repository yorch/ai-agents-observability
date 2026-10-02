// Shared helpers for adapter detect/apply/remove implementations.
// These handle the common patterns: config-dir detection, backup creation,
// and JSON merge with ownership-marker-based idempotency.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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
 *
 * More things a bare temp-then-rename gets wrong on a user's config:
 * - A dotfile manager symlinks `~/.claude/settings.json` into a repo. Renaming
 *   over the link replaces the LINK with a regular file and the managed target
 *   never sees the change, so we resolve the link first (as the kernel would:
 *   relative targets resolve from the link's REAL directory) and rename over the
 *   real file, leaving the symlink in place. Dangling and chained links resolve too.
 *   A target in a read-only store (home-manager's /nix/store) fails with a message
 *   that says so, instead of naming a temp file the user never sees.
 * - The temp name is unique per call (pid + random), so two installs running at
 *   once cannot write one temp file together and then fail the second rename; a
 *   failed write removes its own temp. A SIGKILLed writer leaves its temp behind,
 *   so each write best-effort removes `<name>.aiot-tmp.<pid>.<hex>` siblings that
 *   are over an hour old and whose pid is gone (and nothing else).
 * - The result keeps the target's permission bits (a 0600 file stays 0600) when
 *   no explicit `mode` is given; a new file gets the umask default.
 * - The temp file is created with the target's mode (and O_EXCL), never wider.
 *
 * Limits: a hard-linked config is broken (the rename gives the path a new inode, so
 * the other name keeps the old content); ownership, ACLs and xattrs are not
 * preserved; a dangling link whose parent directories do not exist gets them
 * created (mkdir -p at the link target). Leftover temps with the legacy bare name
 * `<name>.aiot-tmp` are never swept.
 *
 * What it does NOT give: mutual exclusion. Two read-modify-write cycles that
 * interleave (an apply racing Claude Code's own write to settings.json, or a user
 * edit) each rename a complete file, so neither corrupts it, but the later one
 * silently drops the earlier one's change.
 */
export function writeFileAtomic(filePath: string, contents: string, mode?: number): void {
  const target = resolveSymlinks(filePath);
  mkdirSync(dirname(target), { recursive: true });
  removeStaleTemps(target);
  const intended = mode ?? existingMode(target);
  const tmpPath = `${target}.aiot-tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    // Created with its final mode and O_EXCL: the contents (settings.json can hold
    // `env` and `apiKeyHelper`) are never readable by more than the target was, not
    // even for the moment between the write and a chmod, and a link planted at the
    // temp name is refused instead of followed.
    writeFileSync(tmpPath, contents, { encoding: 'utf8', flag: 'wx', mode: intended });
    if (mode === undefined && intended !== undefined) {
      chmodSync(tmpPath, intended); // only restores bits the umask stripped at creation
    }
    renameSync(tmpPath, target);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
      if (isSymlink(filePath)) {
        throw new Error(
          `${filePath} is a symlink into a read-only location (${target}); aiot cannot update it — make the target writable, or unlink it and let aiot own the file`,
        );
      }
      if (dirname(target) !== dirname(filePath)) {
        // A parent directory is a symlink and the real one cannot take the temp file:
        // name it, instead of an error about a temp file in a place the user never sees.
        throw new Error(`${filePath}: ${dirname(target)} is not writable (${code})`);
      }
    }
    throw err;
  }
}

/** Is the FILE itself a link (not merely something under a linked directory)? */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

const STALE_TEMP_MS = 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'; // EPERM: alive, not ours
  }
}

/** Remove `<target>.aiot-tmp.<pid>.<hex>` regular files that are old and whose writer is gone. */
function removeStaleTemps(target: string): void {
  try {
    const dir = dirname(target);
    const prefix = `${basename(target)}.aiot-tmp.`;
    for (const name of readdirSync(dir)) {
      const m = name.startsWith(prefix)
        ? /^(\d+)\.[0-9a-f]{8}$/.exec(name.slice(prefix.length))
        : null;
      if (!m) {
        continue;
      }
      const path = join(dir, name);
      const st = lstatSync(path); // never follow a link
      if (st.isFile() && Date.now() - st.mtimeMs > STALE_TEMP_MS && !pidAlive(Number(m[1]))) {
        rmSync(path, { force: true });
      }
    }
  } catch {
    // best effort: clutter, not a failure
  }
}

function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The file a write to `path` really lands on. An existing file resolves with
 * realpath. A dangling link is walked hop by hop, each relative target resolved
 * against the REAL directory of the link that holds it (a lexical `dirname` is
 * wrong when the link's own directory is a symlink).
 */
function resolveSymlinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // missing, or a dangling link: walk it
  }
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    let target: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) {
        return current;
      }
      target = readlinkSync(current);
    } catch {
      return join(realDir(dirname(current)), basename(current)); // plain missing file
    }
    current = resolve(realDir(dirname(current)), target);
  }
  throw new Error(`Too many levels of symbolic links: ${path}`);
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
