import type { Event } from '@ai-agents-observability/schemas';

import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { opencodeAdapter } from './opencode';

// A hook adapter translates one agent's native hook protocol into the
// agent-neutral transport (queue → flusher → ingest; ship marker → shipper).
// The transport (queue.ts, flusher.ts, shipper.ts, retry/abandon) never branches
// on agent — everything agent-specific lives behind this contract.
//
// VALIDATED (P8-003 → P8-004): the interface held unchanged across a real second
// adapter (opencode). It was extended ONCE, with the optional `mapBatch`, for the
// third adapter (codex, P8-007): Codex's `notify` fires once per turn but the
// turn's tool calls + usage live in a separate rollout file, so one invocation
// legitimately yields N events. Adding it as OPTIONAL kept claude-code/opencode
// byte-for-byte identical (they emit one event per hook and omit it).

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
  /**
   * Optional: translate ONE hook invocation into MANY events. When present and it
   * returns a non-null array, the transport enqueues every event and skips
   * `mapPayload`; returning null falls back to the single-event `mapPayload`. Added
   * for codex (P8-007), whose per-turn `notify` expands into the turn's tool calls
   * + a usage-bearing Stop read from the rollout file.
   */
  mapBatch?(kind: string, raw: Record<string, unknown>): ConformantEvent[] | null;
  /** Translate a raw stdin hook payload for `kind` into a ConformantEvent. */
  mapPayload(kind: string, raw: Record<string, unknown>): ConformantEvent;
  /** For a terminal event, the transcript to ship (null when none applies). */
  transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null;
}

const ADAPTERS: Record<string, HookAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export const DEFAULT_ADAPTER = 'claude-code';

/** Select an adapter by agent name; falls back to the default (claude-code). */
export function selectAdapter(agent: string = DEFAULT_ADAPTER): HookAdapter {
  return ADAPTERS[agent] ?? claudeCodeAdapter;
}
