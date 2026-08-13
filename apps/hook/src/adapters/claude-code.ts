import type { Event } from '@ai-agents-observability/schemas';

import {
  buildClaudeToolInfo,
  CLAUDE_KNOWN_KEYS,
  type ClaudeCodeHookPayload,
  enrichClaudeMetadata,
  HOOK_KIND_TO_EVENT_TYPE,
  type HookKind,
} from '../lib/payload';
import { createStdinHookAdapter } from './stdin-hook-factory';

// Claude Code adapter — the first HookAdapter implementation, and (since P12-003)
// the first caller of the stdin-hook factory. The Claude-specific pieces live in
// lib/payload.ts; everything here is configuration.

const HOOK_KINDS = Object.keys(HOOK_KIND_TO_EVENT_TYPE) as HookKind[];

// Maps CLI arg kind (kebab-case) to the PascalCase event name Claude Code
// expects as a key in ~/.claude/settings.json. Identical to the canonical
// EventType for every kind, but kept explicit: they are two different namespaces
// that happen to agree, and a future divergence should not silently rename a hook.
const HOOK_KIND_TO_SETTINGS_KEY: Record<HookKind, string> = HOOK_KIND_TO_EVENT_TYPE;

// Exec form (command + args array) so Claude Code spawns the binary directly
// rather than routing through `sh -c`. This avoids shell word-splitting on
// binary paths that contain spaces, and eliminates any metacharacter injection
// surface regardless of the install location.
type HookEntry = { args: string[]; command: string; type: string };
type HookGroup = { hooks: HookEntry[] };

function renderSnippet(bin: string): string {
  const hooks: Record<string, HookGroup[]> = {};
  for (const kind of HOOK_KINDS) {
    hooks[HOOK_KIND_TO_SETTINGS_KEY[kind]] = [
      { hooks: [{ args: ['hook', kind], command: bin, type: 'command' }] },
    ];
  }
  return JSON.stringify({ hooks }, null, 2);
}

export const claudeCodeAdapter = createStdinHookAdapter({
  agentType: 'CLAUDE_CODE',
  buildTool: (raw) => buildClaudeToolInfo(raw),
  enrich: (event, _kind, raw) => {
    enrichClaudeMetadata(event.metadata, event.event_type, raw);
  },
  eventMap: HOOK_KIND_TO_EVENT_TYPE,
  install: {
    agentName: 'Claude Code',
    renderSnippet,
    settingsHint: 'Add to ~/.claude/settings.json:',
  },
  knownKeys: CLAUDE_KNOWN_KEYS,
  // Claude Code ships the transcript at Stop. The path + session id come from the
  // hook payload (transcript_path / session_id), not a computed location.
  transcriptKinds: ['stop'],
});

/**
 * Claude Code's hook payload → canonical Event. Thin wrapper over the adapter,
 * kept because the queue and the mapping tests address it by name.
 */
export function toEvent(kind: HookKind, raw: ClaudeCodeHookPayload): Event {
  return claudeCodeAdapter.mapPayload(kind, raw) as Event;
}

export { isHookKind } from '../lib/payload';
export type { HookKind };
