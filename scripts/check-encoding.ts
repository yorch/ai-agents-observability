/**
 * Fails the build if a source file is binary as far as git is concerned.
 *
 * Why this exists: a single NUL byte reached `apps/web/src/lib/login-rate-limit.ts`
 * in a security fix. Every gate passed — Biome, tsc, the build and all 16 test
 * tasks — because a NUL inside a template literal is valid TypeScript. It changed
 * one map-key separator and nothing else.
 *
 * What it broke was review. Git classifies a file containing NUL as binary, so
 * GitHub renders "Binary file not shown" instead of a diff. On a security PR the
 * reviewer could not see what changed in the rate limiter. A defect invisible to
 * every automated check and visible only to a human opening the Files tab is
 * exactly the kind worth spending a gate on.
 *
 * The check deliberately asks GIT rather than scanning for NUL ourselves, because
 * git's answer is the one that decides whether a diff renders — the same
 * detection GitHub applies. `git ls-files --eol` reports `i/-text` for any tracked
 * file git considers binary.
 *
 * Genuinely binary assets are allowed by extension. Adding a new binary type
 * means adding it here, which is the point: the exemption gets argued in a diff
 * rather than assumed, the same way `run-kind-exempt` works elsewhere.
 *
 * Usage: bun run scripts/check-encoding.ts   (wired into `bun run check`)
 */

/** Extensions whose contents are legitimately not text. */
const BINARY_EXTENSIONS = new Set([
  'ico',
  'gif',
  'jpeg',
  'jpg',
  'pdf',
  'png',
  'webp',
  'woff',
  'woff2',
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

const proc = Bun.spawnSync(['git', 'ls-files', '--eol']);
if (proc.exitCode !== 0) {
  console.error('check-encoding: `git ls-files --eol` failed');
  console.error(new TextDecoder().decode(proc.stderr));
  process.exit(2);
}

const lines = new TextDecoder().decode(proc.stdout).split('\n').filter(Boolean);

// Guard against the check silently passing because it examined nothing — a green
// result must mean "looked and found none", never "found nothing to look at".
if (lines.length < 100) {
  console.error(
    `check-encoding: only ${lines.length} tracked files seen; expected the whole repo. ` +
      'Refusing to report success on a scan that clearly did not run.',
  );
  process.exit(2);
}

const offenders: string[] = [];
for (const line of lines) {
  // Format: "i/<eol> w/<eol> attr/<attrs>\t<path>"; binary shows as `-text`.
  //
  // Both columns matter, and checking only the index was a real bug in this
  // script: an edited-but-unstaged file reports `i/lf w/-text`, so an index-only
  // check passed at precisely the moment the author could still fix it cheaply.
  // `w/` catches it before `git add`, `i/` after.
  const tab = line.indexOf('\t');
  if (tab === -1) {
    continue;
  }
  const path = line.slice(tab + 1);
  const isBinaryToGit = line.slice(0, tab).includes('-text');
  if (isBinaryToGit && !BINARY_EXTENSIONS.has(extensionOf(path))) {
    offenders.push(path);
  }
}

if (offenders.length > 0) {
  console.error(
    `check-encoding: ${offenders.length} source file(s) are binary to git, so their diffs will not render for review:\n`,
  );
  for (const path of offenders) {
    console.error(`  ${path}`);
  }
  console.error(
    '\nUsually a stray NUL byte (0x00). Find it with:\n' +
      "  LC_ALL=C grep -c $'\\0' <file>\n" +
      '  od -c <file> | grep -n "\\\\0"\n' +
      '\nIf the file is genuinely a binary asset, add its extension to ' +
      'BINARY_EXTENSIONS in scripts/check-encoding.ts.',
  );
  process.exit(1);
}

console.log(`check-encoding: ${lines.length} tracked files, no source file is binary to git.`);
