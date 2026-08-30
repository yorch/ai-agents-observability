import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { homeDir as configHomeDir, dirExists, writeTextFile } from '../lib/config-wire';

import type { HookAdapter } from './index';
import { createPiFamilyAdapter, renderExtensionSnippet } from './pi-family';

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

const PI_HOME = () => process.env.PI_HOME ?? join(configHomeDir(), '.pi');

// Which Pi events we subscribe to, and the hook kind each becomes, is
// PI_FAMILY_NATIVE_EVENTS. `turn_end` (one LLM response + its tool calls) is the
// Stop, NOT `agent_settled` — cost is attributed per turn, while agent_settled
// fires once per agent run after auto-retry / auto-compaction / queued
// follow-ups. If session-level "done" turns out to matter for effectiveness
// signals, add it then; it is a different event, not a better one.

function renderSnippet(bin: string): string {
  return renderExtensionSnippet({
    agentArg: 'pi',
    bin,
    header: '// ~/.pi/agent/extensions/telemetry.ts  (or .pi/extensions/telemetry.ts)',
    paramName: 'pi',
    sessionFileExpr: 'ctx?.sessionManager?.path ?? undefined',
    sessionIdExpr: 'ctx?.sessionManager?.sessionId ?? event?.sessionId',
  });
}

// ── Auto-wire: detect / apply / remove ────────────────────────────────────────

const PI_EXTENSIONS_DIR = () => join(PI_HOME(), 'agent', 'extensions');
const PI_PLUGIN_FILE = () => join(PI_EXTENSIONS_DIR(), 'telemetry.ts');

function detectPi(): boolean {
  return dirExists(PI_HOME());
}

function applyPi(bin: string): string | null {
  const pluginFile = PI_PLUGIN_FILE();
  try {
    writeTextFile(pluginFile, renderSnippet(bin));
    return `wrote ${pluginFile}`;
  } catch (err) {
    process.stderr.write(`Error wiring Pi: ${(err as Error).message}\n`);
    return null;
  }
}

function removePi(): boolean {
  const pluginFile = PI_PLUGIN_FILE();
  try {
    if (existsSync(pluginFile)) {
      rmSync(pluginFile, { force: true });
    }
    return true;
  } catch (err) {
    process.stderr.write(`Error removing Pi extension: ${(err as Error).message}\n`);
    return false;
  }
}

export const piAdapter: HookAdapter = createPiFamilyAdapter({
  agentType: 'PI',
  install: {
    agentName: 'Pi',
    apply: applyPi,
    detect: detectPi,
    remove: removePi,
    renderSnippet,
    settingsHint: 'Add a Pi extension (~/.pi/agent/extensions/telemetry.ts):',
  },
  sessionRoots: () => [join(PI_HOME(), 'agent', 'sessions')],
});
