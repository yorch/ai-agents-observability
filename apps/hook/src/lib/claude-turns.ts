import type { Event } from '@ai-agents-observability/schemas';

import type { ClaudeEntry } from './transcript-parser';
import { deterministicEventId } from './uuid5';

// The ONE place a Claude Code transcript entry is turned into a turn (P14-003).
//
// Two callers derive events from the same `~/.claude/projects/<enc>/<id>.jsonl`:
// the `import` subcommand (lib/import-synth.ts, historical backfill) and the live
// Stop hook (adapters/claude-code.ts, which reads the turns appended since the
// last Stop). They MUST agree byte-for-byte on the event id, the timestamp and
// the token counts, because that agreement is the only thing standing between a
// live-captured session and a re-import billing it twice: ingest dedupes on
// `ON CONFLICT (event_id, ts) DO NOTHING`, which needs BOTH to match — and
// `sessions.total_cost_usd` accumulates (`= sessions.x + EXCLUDED.x`) and is
// never recomputed, so a double count cannot drift back into agreement.
//
// Hence this module rather than two parsers. It is pure: no I/O, no clock, no
// process state, so both callers are testable against the same fixtures.
//
// CONTENT-FREE. Only `type`, `uuid`, `timestamp`, `message.model` and
// `message.usage` are read. No prompt text, tool input or tool output is
// extracted, so nothing here needs to pass `packages/redaction` — the transcript
// itself is still redacted separately by the shipper before it reaches S3.

/**
 * Ensure `ts` carries a timezone offset — `z.iso.datetime({ offset: true })`
 * rejects one without. Claude Code writes ISO 8601 with a `Z` already; the
 * fallbacks cover an absent or truncated field.
 */
export function normalizeTs(ts: string | undefined): string {
  if (!ts) {
    return new Date().toISOString();
  }
  if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) {
    return ts;
  }
  return `${ts}Z`;
}

/**
 * The id seed for the Stop event synthesized from an assistant entry.
 *
 * Deriving it from the entry's own uuid is what makes live capture and import
 * produce the SAME event_id for the same turn. Changing this string re-bills
 * every previously imported session, exactly like changing IMPORT_NAMESPACE.
 */
export function stopIdSeed(entry: ClaudeEntry, ts: string): string {
  return `${entry.uuid ?? ts}:stop`;
}

/** {@link stopIdSeed} resolved to the deterministic (uuidv7-shaped) event id. */
export function stopEventId(entry: ClaudeEntry, ts: string): string {
  return deterministicEventId(stopIdSeed(entry, ts));
}

/** Clamp a transcript-supplied count to a non-negative integer. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * The `llm` block for one assistant turn, or null when the entry carries no
 * usage (a text-only continuation, a truncated line, a synthetic entry).
 *
 * Anthropic's four counts are already DISJOINT — `input_tokens` excludes both
 * cache counters — which is exactly the shape ingest's `computeCostUsd` bills, so
 * unlike the Codex and Gemini adapters there is nothing to subtract here. Do not
 * "normalize" these: subtracting would under-bill every Claude Code turn.
 *
 * `cost_usd` is 0 by contract (DESIGN_DOC §6.7): ingest recomputes it from the
 * versioned per-agent price table, so a price correction never needs a hook
 * redeploy.
 */
export function llmFromEntry(entry: ClaudeEntry): NonNullable<Event['llm']> | null {
  const usage = entry.message?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheCreation = count(usage.cache_creation_input_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
    return null;
  }
  const model = entry.message?.model;
  return {
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    cost_usd: 0,
    input_tokens: input,
    model: typeof model === 'string' && model.length > 0 ? model : 'unknown',
    output_tokens: output,
  };
}

/**
 * The `tool_use` block ids this assistant turn issued, in transcript order.
 *
 * IDS ONLY — never the block's `name` or `input`. This is the same content-free
 * rule the rest of this module keeps, and it is what lets the list ride on a
 * Stop event's metadata without passing `packages/redaction`.
 *
 * These are the ids Claude Code also hands the live `PreToolUse`/`PostToolUse`
 * hooks as `tool_use_id`, which is the entire basis of P14-006: the turn that
 * issued a call is knowable at Stop, the call itself is knowable at the tool
 * hook, and the two name it identically, so ingest can join them on
 * `(session_id, tool_use_id)` with no heuristic and no hot-path I/O.
 */
export function toolUseIdsOf(entry: ClaudeEntry): string[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_use' &&
      typeof (block as { id?: unknown }).id === 'string' &&
      (block as { id: string }).id.length > 0
    ) {
      ids.push((block as { id: string }).id);
    }
  }
  return ids;
}

/** One assistant turn, as both derivation paths see it. */
export type AssistantTurn = {
  /** Deterministic id of this turn's Stop event. */
  eventId: string;
  /** Token usage, or null when the entry reported none. */
  llm: NonNullable<Event['llm']> | null;
  /** Ids of the tool calls this turn issued. See {@link toolUseIdsOf}. */
  toolUseIds: string[];
  /** Normalized entry timestamp — the Stop event's `ts`. */
  ts: string;
};

/** True for the entries that count as an assistant turn (and so bump the ordinal). */
export function isAssistantEntry(entry: unknown): entry is ClaudeEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    (entry as ClaudeEntry).type === 'assistant'
  );
}

/** Derive the turn an assistant entry represents. Callers own the ordinal. */
export function assistantTurn(entry: ClaudeEntry): AssistantTurn {
  const ts = normalizeTs(entry.timestamp);
  return {
    eventId: stopEventId(entry, ts),
    llm: llmFromEntry(entry),
    toolUseIds: toolUseIdsOf(entry),
    ts,
  };
}

/**
 * The metadata key a Stop event carries its turn's {@link toolUseIdsOf} under.
 *
 * Named here rather than spelled inline in the two producers and the one
 * consumer, because it is a cross-workspace contract: `apps/hook` writes it and
 * `apps/ingest`'s `link-turn-events` job reads it. Ingest cannot import this
 * constant (the hook is a CLI, not a library), so the string is restated there
 * with a pointer back — and pinned from both sides by a test.
 *
 * Absent when the turn issued no tools. An empty array and a missing key mean
 * the same thing, so the smaller one is written.
 */
export const TOOL_USE_IDS_METADATA_KEY = 'tool_use_ids';

/** `{ tool_use_ids: [...] }` for a turn that issued tools, `{}` for one that did not. */
export function toolUseIdsMetadata(toolUseIds: string[]): Record<string, string[]> {
  return toolUseIds.length > 0 ? { [TOOL_USE_IDS_METADATA_KEY]: toolUseIds } : {};
}
