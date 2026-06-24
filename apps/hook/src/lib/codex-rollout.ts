import { fieldBytes } from './bytes';

// Parser for OpenAI Codex CLI "rollout" session logs (P8-007). Codex's only
// stable extension point is its `notify` program, which fires once per turn
// (agent-turn-complete) and carries no per-tool or token data. The rich record
// — tool calls, token usage, the full conversation — lives in the per-session
// rollout JSONL under `~/.codex/sessions/…/rollout-<ts>-<uuid>.jsonl`.
//
// This module is the PURE core: it turns already-parsed rollout records into
// agent-neutral tool-call descriptors + cumulative usage. All file I/O, cursor
// state, and Event assembly live in the adapter (adapters/codex.ts); keeping the
// parsing pure makes the version-sensitive rollout format unit-testable.
//
// The rollout schema has shifted across Codex versions (older = flat records,
// newer = a `{ type, payload }` envelope), and MCP/provider tools vary, so every
// extraction here is defensive: recognized shapes are read, everything else is
// skipped. The raw rollout is always shipped as the transcript, so unrecognized
// records are never lost — only their derived counts.

export type CodexToolCall = {
  name: string;
  inputBytes: number;
  outputBytes: number;
  wasDenied: boolean;
};

export type CodexUsage = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type RolloutParse = {
  toolCalls: CodexToolCall[];
  // Latest CUMULATIVE usage seen in these records. Codex's `token_count` event is
  // a running session total, so the adapter diffs this against the stored cursor
  // to get the per-turn delta (never sums totals — that would overcount).
  cumulativeUsage: CodexUsage | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Unwrap a rollout line into { type, body }. Newer Codex wraps the real record in
// a `{ type, payload }` envelope; older versions are flat. Tolerate both.
function unwrap(rec: Record<string, unknown>): { type: string; body: Record<string, unknown> } {
  if (isRecord(rec.payload)) {
    return {
      body: rec.payload,
      type: (str(rec.payload.type) ?? str(rec.type) ?? '').toLowerCase(),
    };
  }
  return { body: rec, type: (str(rec.type) ?? '').toLowerCase() };
}

// Pull a usage block out of any of the shapes Codex has used:
//   { input_tokens, output_tokens, cached_input_tokens }
//   { info: { total_token_usage: { input_tokens, … } } }
//   { usage: { input_tokens, … } }
function extractUsage(body: Record<string, unknown>): CodexUsage | null {
  const info = isRecord(body.info) ? body.info : undefined;
  const candidates: unknown[] = [
    body,
    info?.total_token_usage,
    info?.last_token_usage,
    body.usage,
    body.total_token_usage,
  ];
  for (const c of candidates) {
    if (!isRecord(c)) {
      continue;
    }
    const input = c.input_tokens ?? c.input;
    const output = c.output_tokens ?? c.output;
    if (typeof input === 'number' || typeof output === 'number') {
      return {
        cacheReadTokens: numOr0(c.cached_input_tokens ?? c.cache_read_tokens ?? c.cache_read),
        cacheWriteTokens: numOr0(c.cache_creation_tokens ?? c.cache_write_tokens ?? c.cache_write),
        inputTokens: numOr0(input),
        model: null,
        outputTokens: numOr0(output),
      };
    }
  }
  return null;
}

export function parseRolloutRecords(records: unknown[]): RolloutParse {
  const byCallId = new Map<string, CodexToolCall>();
  const ordered: CodexToolCall[] = [];
  let model: string | null = null;
  let cumulative: CodexUsage | null = null;

  for (const rec of records) {
    if (!isRecord(rec)) {
      continue;
    }
    const { type, body } = unwrap(rec);

    // Model surfaces on session_meta / turn_context records.
    model = str(body.model) ?? str(body.model_id) ?? model;

    const isOutput =
      type.includes('function_call_output') ||
      (str(body.call_id) !== null && body.output !== undefined && str(body.name) === null);
    if (isOutput) {
      const id = str(body.call_id);
      const call = id ? byCallId.get(id) : undefined;
      if (call) {
        call.outputBytes += fieldBytes(body.output ?? body.result);
        const out = typeof body.output === 'string' ? body.output : '';
        if (/declin|reject|denied|not allowed/i.test(out)) {
          call.wasDenied = true;
        }
      }
      continue;
    }

    const isCall =
      (type.includes('function_call') && !type.includes('output')) ||
      (str(body.name) !== null && (body.arguments !== undefined || str(body.call_id) !== null));
    if (isCall) {
      const call: CodexToolCall = {
        inputBytes: fieldBytes(body.arguments ?? body.input ?? body.args),
        name: str(body.name) ?? 'unknown',
        outputBytes: 0,
        wasDenied: false,
      };
      const id = str(body.call_id);
      if (id) {
        byCallId.set(id, call);
      }
      ordered.push(call);
      continue;
    }

    if (
      type.includes('token') ||
      type.includes('usage') ||
      body.input_tokens !== undefined ||
      body.output_tokens !== undefined
    ) {
      const usage = extractUsage(body);
      if (usage) {
        cumulative = usage;
      }
    }
  }

  if (cumulative) {
    cumulative.model = model ?? cumulative.model;
  }
  return { cumulativeUsage: cumulative, toolCalls: ordered };
}

// Per-turn usage = current cumulative − previously-seen cumulative (clamped at 0
// so a session restart that resets the counter can never emit negative tokens).
export function usageDelta(prev: CodexUsage | null, current: CodexUsage | null): CodexUsage | null {
  if (!current) {
    return null;
  }
  if (!prev) {
    return current;
  }
  return {
    cacheReadTokens: Math.max(0, current.cacheReadTokens - prev.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - prev.cacheWriteTokens),
    inputTokens: Math.max(0, current.inputTokens - prev.inputTokens),
    model: current.model ?? prev.model,
    outputTokens: Math.max(0, current.outputTokens - prev.outputTokens),
  };
}
