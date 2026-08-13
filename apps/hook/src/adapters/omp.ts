import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { HookAdapter } from './index';
import { createPiFamilyAdapter, homeDir, renderExtensionSnippet } from './pi-family';

// OMP (oh-my-pi) adapter (P12-008). OMP is a fork of Pi that went the opposite
// direction — subagents, plan mode, LSP/DAP, a Rust core with a TypeScript
// extension layer — but its hooks are Pi's: ES modules receiving a `HookAPI`
// object, not stdin JSON. So it shares Pi's implementation (pi-family.ts) and
// differs only in where things live.
//
// Three OMP-specific traps, all handled here:
//
//   1. Session ids are 16-char hex, NOT UUIDs → P12-002 normalization is
//      mandatory (createPiFamilyAdapter applies it).
//   2. Session files open with a fixed 256-byte title slot before the header, so
//      a naive JSONL reader chokes on the first "line". `safeJsonObject` in
//      pi-family retries from the first `{`, and ingest's transcript indexer does
//      the same.
//   3. The config root is UNRESOLVED: the repo docs say `~/.omp/`, while
//      `omp.sh/docs` (which blocks our fetcher) and several third-party writeups
//      say `~/.oh-omp/`. Both are probed, preferring whichever actually holds a
//      `sessions/` directory. Once verified against a real installation, collapse
//      this to the true one and record which it was.
//
// Sessions are `~/.omp/agent/sessions/<scope>-<project>-<sha256(cwd)>/<ts>_<id>.jsonl`
// — single file per session with per-message usage and cost, so transcript upload
// works on day one, exactly as for Pi.

const OMP_HOME_CANDIDATES = ['.omp', '.oh-omp'];

/**
 * Every plausible sessions root. Both documented config roots are probed (the
 * scan merges candidates and picks by mtime, so order does not matter), and an
 * `OMP_HOME` override is accepted whether it names the config root or the
 * sessions directory itself — a natural misreading that would otherwise find
 * nothing, silently.
 */
let rootsMemo: { key: string; roots: string[] } | null = null;

function sessionRoots(): string[] {
  // Called from both the usage fallback and transcriptTarget in one invocation;
  // the probe is cheap but there is no reason to run it twice.
  const key = process.env.OMP_HOME ?? '';
  if (rootsMemo?.key === key) {
    return rootsMemo.roots;
  }
  const roots = resolveSessionRoots();
  rootsMemo = { key, roots };
  return roots;
}

function resolveSessionRoots(): string[] {
  const override = process.env.OMP_HOME;
  const homes = override ? [override] : OMP_HOME_CANDIDATES.map((name) => join(homeDir(), name));
  const roots = homes.flatMap((home) => [join(home, 'agent', 'sessions'), home]);
  const existing = roots.filter((root) => existsSync(root));
  return existing.length > 0 ? existing : roots;
}

function renderSnippet(bin: string): string {
  return renderExtensionSnippet({
    agentArg: 'omp',
    bin,
    footer: [
      '',
      '// Alternative, if you already run the third-party `omp-hooks` plugin: it makes',
      '// OMP execute Claude Code-style settings.json command hooks, so you can wire',
      `// "${bin} hook <kind> --agent omp" there instead. We ship the native module`,
      '// because it needs no third-party package to keep working.',
    ],
    header: '// ~/.omp/agent/hooks/telemetry.ts   (or ~/.oh-omp/agent/hooks/, or .omp/hooks/)',
    paramName: 'omp',
    sessionFileExpr: 'ctx?.session?.path ?? undefined',
    sessionIdExpr: 'ctx?.session?.id ?? event?.sessionId',
  });
}

export const ompAdapter: HookAdapter = createPiFamilyAdapter({
  agentType: 'OMP',
  install: {
    agentName: 'omp (oh-my-pi)',
    renderSnippet,
    settingsHint: 'Add an OMP hook module (~/.omp/agent/hooks/telemetry.ts):',
  },
  sessionRoots,
});
