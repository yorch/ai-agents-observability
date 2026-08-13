import { join } from 'node:path';

import type { HookAdapter } from './index';
import { createPiFamilyAdapter, homeDir, PI_FAMILY_NATIVE_EVENTS } from './pi-family';

// Pi adapter (P12-007). Pi (`@earendil-works/pi-coding-agent`) has no stdin
// command hooks — it has TypeScript **extensions**: a module exporting
// `export default function (pi: ExtensionAPI) { … }`, auto-loaded from
// `~/.pi/agent/extensions/*.ts` or `.pi/extensions/*.ts`, subscribing with
// `pi.on(eventName, handler)`. So this is the opencode plugin pattern — a thin
// extension that shells out — and it needs no new seam capability.
//
// Pi is the best-shaped agent we capture:
//   - sessions are ONE JSONL file, `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`,
//     so transcript upload works on day one (opencode's gap does not apply);
//   - session ids are already UUIDs — the first non-Claude agent for which
//     P12-002's normalization is a pass-through;
//   - usage (input/output, cache read/write, and a cost breakdown) is recorded
//     per assistant message.
//
// Note for anything that reads the transcript: Pi sessions are TREES. Entries
// carry `id`/`parentId` and branching happens in place, so one file can contain
// abandoned branches. The shipper ships bytes and is unaffected; anything that
// counts must respect `parentId`.
//
// `@earendil-works/pi-telemetry` is deliberately NOT used: it is an
// OpenTelemetry-style span contract for instrumenting Pi's internals, not a
// lifecycle event stream. Wrong seam.

const PI_HOME = () => process.env.PI_HOME ?? join(homeDir(), '.pi');

// Which Pi events we subscribe to, and the hook kind each becomes. `turn_end`
// (one LLM response + its tool calls) is the Stop, NOT `agent_settled` — cost is
// attributed per turn, and agent_settled fires once per agent run after
// auto-retry / auto-compaction / queued follow-ups. If session-level "done" turns
// out to matter for effectiveness signals, add it then; it is a different event,
// not a better one.
const SUBSCRIBED = PI_FAMILY_NATIVE_EVENTS;

function renderSnippet(bin: string): string {
  const mapEntries = Object.entries(SUBSCRIBED)
    .map(([native, kind]) => `  ${native}: '${kind}',`)
    .join('\n');
  return [
    '// ~/.pi/agent/extensions/telemetry.ts  (or .pi/extensions/telemetry.ts)',
    'import { spawn } from "node:child_process";',
    '',
    'const KINDS: Record<string, string> = {',
    mapEntries,
    '};',
    '',
    'export default function (pi: any) {',
    '  for (const [native, kind] of Object.entries(KINDS)) {',
    '    pi.on(native, async (event: any, ctx: any) => {',
    '      try {',
    '        const payload = {',
    '          ...event,',
    '          cwd: ctx?.cwd ?? process.cwd(),',
    '          sessionId: ctx?.sessionManager?.sessionId ?? event?.sessionId,',
    '          sessionFile: ctx?.sessionManager?.path ?? undefined,',
    '        };',
    `        const p = spawn(${JSON.stringify(bin)}, ['hook', kind, '--agent', 'pi'], {`,
    "          stdio: ['pipe', 'ignore', 'ignore'],",
    '          detached: true,',
    '        });',
    '        p.stdin.end(JSON.stringify(payload));',
    '        p.unref();',
    '      } catch {',
    '        // Telemetry must never break the agent: swallow and continue.',
    '      }',
    '      // Return nothing — this extension observes, it never blocks a tool',
    '      // call or rewrites a result, even though pi.on("tool_call") could.',
    '    });',
    '  }',
    '}',
  ].join('\n');
}

export const piAdapter: HookAdapter = createPiFamilyAdapter({
  agentType: 'PI',
  install: {
    agentName: 'Pi',
    renderSnippet,
    settingsHint: 'Add a Pi extension (~/.pi/agent/extensions/telemetry.ts):',
  },
  sessionRoots: () => [join(PI_HOME(), 'agent', 'sessions')],
});
