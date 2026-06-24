import type { Event } from '@ai-agents-observability/schemas';

import { claudeCodeAdapter } from './claude-code';

// A hook adapter translates one agent's native hook protocol into the
// agent-neutral transport (queue → flusher → ingest; ship marker → shipper).
// The transport (queue.ts, flusher.ts, shipper.ts, retry/abandon) never branches
// on agent — everything agent-specific lives behind this contract.
//
// PROVISIONAL (P8-003): this interface is intentionally narrow and will be
// validated/finalized against a real second adapter in P8-004. Resist widening
// it for hypothetical needs before that second example exists.

export type ConformantEvent = Event;

/** Where a terminal (stop) event's transcript lives, for the shipper. */
export type TranscriptTarget = { sessionId: string; transcriptPath: string };

/** Metadata the `install` command needs to wire the agent's hooks. */
export type AdapterInstallConfig = {
  agentName: string;
  /** Hook kinds the agent emits / we register. */
  hookKinds: readonly string[];
  /** Human hint shown before the snippet (where the config goes). */
  settingsHint: string;
  /** Render the agent-native config that wires `<bin> hook <kind>`. */
  renderSnippet(bin: string): string;
};

export interface HookAdapter {
  /** Canonical agent_type stamped on events (matches AgentTypeSchema). */
  readonly agentType: string;
  /** Metadata for the install command. */
  installConfig(): AdapterInstallConfig;
  /** True if `value` is a hook kind this adapter handles. */
  isHookKind(value: string): boolean;
  /** Translate a raw stdin hook payload for `kind` into a ConformantEvent. */
  mapPayload(kind: string, raw: Record<string, unknown>): ConformantEvent;
  /** For a terminal event, the transcript to ship (null when none applies). */
  transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null;
}

const ADAPTERS: Record<string, HookAdapter> = {
  'claude-code': claudeCodeAdapter,
};

export const DEFAULT_ADAPTER = 'claude-code';

/** Select an adapter by agent name; falls back to the default (claude-code). */
export function selectAdapter(agent: string = DEFAULT_ADAPTER): HookAdapter {
  return ADAPTERS[agent] ?? claudeCodeAdapter;
}
