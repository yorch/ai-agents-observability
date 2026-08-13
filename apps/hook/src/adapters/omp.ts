import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { HookAdapter } from './index';
import { createPiFamilyAdapter, homeDir, PI_FAMILY_NATIVE_EVENTS } from './pi-family';

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

/** Both documented config roots, the one with a `sessions/` dir first. */
function sessionRoots(): string[] {
  const override = process.env.OMP_HOME;
  const homes = override ? [override] : OMP_HOME_CANDIDATES.map((name) => join(homeDir(), name));
  const roots = homes.map((home) => join(home, 'agent', 'sessions'));
  const existing = roots.filter((root) => existsSync(root));
  return existing.length > 0 ? existing : roots;
}

const SUBSCRIBED = PI_FAMILY_NATIVE_EVENTS;

function renderSnippet(bin: string): string {
  const mapEntries = Object.entries(SUBSCRIBED)
    .map(([native, kind]) => `  ${native}: '${kind}',`)
    .join('\n');
  return [
    '// ~/.omp/agent/hooks/telemetry.ts   (or ~/.oh-omp/agent/hooks/, or .omp/hooks/)',
    'import { spawn } from "node:child_process";',
    '',
    'const KINDS: Record<string, string> = {',
    mapEntries,
    '};',
    '',
    'export default function (omp: any) {',
    '  for (const [native, kind] of Object.entries(KINDS)) {',
    '    omp.on(native, async (event: any, ctx: any) => {',
    '      try {',
    '        const payload = {',
    '          ...event,',
    '          cwd: ctx?.cwd ?? process.cwd(),',
    '          sessionId: ctx?.session?.id ?? event?.sessionId,',
    '          sessionFile: ctx?.session?.path ?? undefined,',
    '        };',
    `        const p = spawn(${JSON.stringify(bin)}, ['hook', kind, '--agent', 'omp'], {`,
    "          stdio: ['pipe', 'ignore', 'ignore'],",
    '          detached: true,',
    '        });',
    '        p.stdin.end(JSON.stringify(payload));',
    '        p.unref();',
    '      } catch {',
    '        // Telemetry must never break the agent: swallow and continue.',
    '      }',
    '      // Observe only: never omp.sendMessage(), never block a tool call.',
    '    });',
    '  }',
    '}',
    '',
    '// Alternative, if you already run the third-party `omp-hooks` plugin: it makes',
    '// OMP execute Claude Code-style settings.json command hooks, so you can wire',
    `// "${bin} hook <kind> --agent omp" there instead. We ship the native module`,
    '// because it needs no third-party package to keep working.',
  ].join('\n');
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
