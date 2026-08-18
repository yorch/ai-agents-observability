/**
 * Capture-side derivations that make the deterministic trajectory scorers
 * (P13-003) possible without ever storing tool input.
 *
 * `DESIGN_DOC.md` §9.3 is absolute: raw tool I/O never leaves the machine and is
 * never stored server-side. But "the same file was edited five times" and "a test
 * command ran before the PR merged" are not content — they are *facts about the
 * trajectory*. Both are derivable at capture time and reducible to something that
 * carries no text:
 *
 * - `toolTargetHash` — a non-reversible digest of the *target* of a call (a path,
 *   a glob, a URL, a shell command), so repeated work against one target is
 *   countable without the target ever being transmitted.
 * - `classifyCommandAction` — a five-way label over a shell command, so
 *   "did this session run tests" is answerable without storing the command.
 *
 * Both run on the hook's hot path, so both are deliberately allocation-light:
 * one key lookup and one pass over a short string. Neither touches the tool's
 * *output*, and neither is applied to the full tool input — only to the small
 * target field, which is why the <10 ms budget (`apps/hook/AGENTS.md`) survives.
 *
 * Living in `packages/schemas` rather than the hook means every adapter derives
 * these identically; an agent whose payload has no recognizable target simply
 * gets `null`, and the scorers that need one return null in turn rather than
 * inventing a number.
 */

/**
 * Coarse classes of shell command. Deliberately tiny — this is a label used to
 * answer "were tests run", not an attempt to describe what the command did.
 * `other` is a real answer, not a failure.
 */
export const TOOL_ACTIONS = ['test', 'build', 'lint', 'vcs', 'pkg', 'other'] as const;

export type ToolAction = (typeof TOOL_ACTIONS)[number];

// Anchored at the start so `git commit` classifies as vcs but `grep git` does not.
const VCS_RE = /^\s*(?:sudo\s+)?(?:git|gh|jj|hg|svn)\b/i;
// Test runners and the conventional script names that invoke them. `\btest\b`
// alone would classify `ls test/` as a test run, so the runner names carry most
// of the weight and the bare word is only matched after a run-ish verb.
const TEST_RE =
  /\b(?:jest|vitest|pytest|mocha|rspec|phpunit|junit|gotestsum|nextest)\b|\b(?:go|cargo|bun|npm|pnpm|yarn|deno|mix|dotnet|swift)\s+test\b|\b(?:run|exec)\s+(?:[\w:-]*\s+)?test(?:s|:[\w-]+)?\b/i;
const LINT_RE = /\b(?:eslint|biome|ruff|clippy|prettier|rubocop|golangci-lint|lint|fmt|format)\b/i;
const BUILD_RE = /\b(?:tsc|webpack|vite|rollup|esbuild|make|cmake|gradle|maven|mvn|build)\b/i;
const PKG_RE =
  /\b(?:pip|poetry|uv|bundle|brew)\s+install\b|\b(?:npm|pnpm|yarn|bun|deno)\s+(?:install|add|i)\b|\bcargo\s+add\b/i;

/**
 * Classify a shell command into a `ToolAction`.
 *
 * Order matters and encodes the precedence a reader would expect: a VCS command
 * is a VCS command even if the branch name contains "test"; a package install is
 * an install even though `npm install` also builds. Returns `null` for an empty
 * command — the caller should store `null` rather than `other`, because
 * "unclassifiable" and "classified as nothing special" are different facts.
 *
 * This is a heuristic and will mislabel adversarial commands (`echo "run tests"`).
 * It is used only by scorers that already gate on volume, so a single mislabel
 * cannot move a score much — see `trajectory.ts`.
 */
export function classifyCommandAction(command: string): ToolAction | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Bound the scan: a heredoc or an inlined script can be arbitrarily long, and
  // the classifying verb is always near the front.
  const head = trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;
  if (VCS_RE.test(head)) {
    return 'vcs';
  }
  if (PKG_RE.test(head)) {
    return 'pkg';
  }
  if (TEST_RE.test(head)) {
    return 'test';
  }
  if (LINT_RE.test(head)) {
    return 'lint';
  }
  if (BUILD_RE.test(head)) {
    return 'build';
  }
  return 'other';
}

/**
 * Fields, in precedence order, that name what a tool call acted *on*. Cross-agent
 * by construction: Claude Code writes `file_path`, opencode writes `path`, codex's
 * patch tool writes `path`, and every agent's shell tool writes `command`.
 *
 * `command` is last so a tool that carries both a path and a command hashes the
 * path — the more stable identity of the two.
 */
const TARGET_KEYS = [
  'file_path',
  'filePath',
  'notebook_path',
  'notebookPath',
  'path',
  'pattern',
  'url',
  'command',
] as const;

/** The shell-command field, checked separately because only it gets an action. */
const COMMAND_KEYS = ['command', 'cmd'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty string among `keys`, or null. */
function pickString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * 64-bit FNV-1a, computed as two interleaved 32-bit lanes with different offset
 * bases and emitted as 16 hex characters.
 *
 * Two lanes rather than one because an 8-hex-character digest of a *file path*
 * is brute-forceable against a path dictionary, and a path is more identifying
 * than the platform wants to store. Two lanes rather than a real cryptographic
 * hash because this runs on the hook's hot path and the threat model is
 * "don't hand out a reversible identifier", not "resist a funded attacker" —
 * the value is never a security boundary, only a grouping key within one
 * session.
 */
export function targetDigest(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + i), 0x85ebca6b);
  }
  const hi = (a >>> 0).toString(16).padStart(8, '0');
  const lo = (b >>> 0).toString(16).padStart(8, '0');
  return hi + lo;
}

/**
 * Digest of what a tool call acted on, or null when the payload names no target.
 *
 * Returning null is the common case for MCP tools and for agents whose payloads
 * are opaque — that is intended. Every scorer keyed on the target treats a null
 * as "not observable" and excludes the call rather than bucketing it with other
 * unknowns, which would fabricate repeats.
 */
export function toolTargetHash(input: unknown): string | null {
  if (typeof input === 'string') {
    return input.length > 0 ? targetDigest(input) : null;
  }
  if (!isRecord(input)) {
    return null;
  }
  const target = pickString(input, TARGET_KEYS);
  return target === null ? null : targetDigest(target);
}

/**
 * Action label for a tool call, or null when the payload carries no shell
 * command. Only commands are classified: labelling a `Read` as `other` would
 * make "no test command ran" indistinguishable from "no command ran at all".
 */
export function toolActionFor(input: unknown): ToolAction | null {
  if (!isRecord(input)) {
    return null;
  }
  const command = pickString(input, COMMAND_KEYS);
  return command === null ? null : classifyCommandAction(command);
}
