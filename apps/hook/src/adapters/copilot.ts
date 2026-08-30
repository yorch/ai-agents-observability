import type { EventType, ToolInfo } from '@ai-agents-observability/schemas';

import type { HookAdapter } from './index';
import {
  buildGenericToolInfo,
  createStdinHookAdapter,
  type FieldAliases,
} from './stdin-hook-factory';

// GitHub Copilot CLI adapter (P12-006). Copilot's hooks are a versioned JSON
// document — `{ version: 1, hooks: { <event>: [{ type: "command", … }] } }` —
// discovered from a layered set of locations (`~/.copilot/hooks/`,
// `.github/hooks/*.json`, `~/.copilot/settings.json`, policy dirs, plugins). The
// payload is Claude-shaped, so capture is the stdin-hook factory plus two
// Copilot-specific wrinkles:
//
//   1. Fields are camelCase (`sessionId`, `toolName`, `toolArgs`, `toolResult`),
//      but Copilot documents PascalCase event aliases whose payloads use the
//      snake_case spellings — so every field is read under BOTH spellings rather
//      than betting on one.
//   2. `preToolUse` command hooks are FAIL-CLOSED: a crash or non-zero exit denies
//      the tool call. Our binary already exits 0 unconditionally (hook-entry.ts
//      swallows everything) — that invariant is load-bearing for this agent in a
//      way it is not for the others. Do not "improve" it.
//
// Lifecycle mapping (copilot event → canonical EventType):
//   sessionStart / sessionEnd    → SessionStart / SessionEnd
//   userPromptSubmitted          → UserPromptSubmit
//   preToolUse / postToolUse     → PreToolUse / PostToolUse
//   postToolUseFailure           → PostToolUse (with a non-zero exit_status)
//   preCompact                   → PreCompact
//   agentStop                    → Stop
//   subagentStop                 → SubagentStop
//   notification                 → Notification
// userPromptTransformed, permissionRequest, subagentStart and errorOccurred have
// no canonical equivalent and are dropped rather than mapped to an invented type.
//
// ── P14-007: why there is no usage capture here ─────────────────────────────
//
// Claude Code, Codex and Gemini CLI each fold per-turn token usage onto their
// turn-completion event via `mapBatch`, reading a side channel their hook
// payload points at (P14-003). Copilot CLI has NO equivalent, checked against
// GitHub's current hooks reference (docs.github.com/en/copilot/reference/
// hooks-reference, re-verified 2026-08-26) rather than assumed from P12-006:
//
//   - No hook payload — agentStop included — carries any token, usage, or
//     model field. The documented `agentStop` shape is exactly
//     `{ sessionId, timestamp, cwd, transcriptPath, stopReason,
//     stop_hook_active }`. (`transcriptPath` is new since P12-006 — see the
//     note on `transcriptTarget` below — but it does not change this.)
//   - The rich per-call usage event Copilot DOES emit internally
//     (`assistant.usage`: model, inputTokens, outputTokens, cacheReadTokens,
//     cacheWriteTokens, reasoningTokens, cost) is real, but it is part of the
//     separate Copilot **SDK**'s opt-in streaming/RPC surface for custom
//     built-on-Copilot applications (docs.github.com/en/copilot/how-tos/
//     copilot-sdk/features/{streaming-events,usage-and-billing}) — a
//     different integration point the CLI's own hook process cannot reach.
//   - The CLI does write its own internal per-session log
//     (`~/.copilot/session-state/<id>/events.jsonl`) that some third-party
//     tools reverse-engineer for a session-total (not per-turn) usage
//     aggregate on a `session.shutdown` entry. That is not a foundation this
//     adapter builds on: it is undocumented (GitHub's own
//     github/copilot-cli#3551 asks GitHub to formalize it as public API,
//     which as of this writing it is not), community sources directly
//     disagree on whether it is reliably persisted at all, and — even where
//     present — it is scoped to the whole CLI session (one entry, at
//     terminal exit) rather than to a turn, which would not satisfy the
//     per-turn granularity every other adapter provides.
//   - Separately, and regardless of the above: `apps/ingest/src/data/
//     price-table.copilot.v1.json` was INTENTIONALLY empty, so even a
//     captured token count would have priced at `$0`. **That is no longer
//     true** — see the P14-015 note below.
//
// Net: this is a well-evidenced negative, not an oversight. Re-open this if
// GitHub documents usage on a CLI hook payload, or formalizes events.jsonl.
//
// ── P14-015: the price table caught up; this adapter is now the only blocker ──
//
// GitHub replaced premium requests with token-metered AI credits on 2026-06-01
// and publishes a per-model per-Mtok rate, so `price-table.copilot.v2.json`
// prices 32 models. Copilot spend is therefore no longer blocked on pricing at
// all — it is blocked here, and only here: a captured `llm` block would cost
// correctly the moment it arrived.
//
// Two things a future capture attempt must supply, re-verified against
// docs.github.com/en/copilot/reference/hooks-reference on 2026-08-27 (the
// finding above still holds; this adds the model half):
//
//   - TOKENS. Still nowhere in any documented payload.
//   - A MODEL. Also nowhere — checked field-by-field across all thirteen
//     documented events. `sessionStart` is `{ sessionId, timestamp, cwd,
//     source, initialPrompt? }` and `userPromptSubmitted` is `{ sessionId,
//     timestamp, cwd, prompt }`; neither names one. The CLI resolves its model
//     from (highest first) a custom agent definition, `--model`, `COPILOT_MODEL`,
//     `~/.copilot/settings.json`, then an unnamed default — so a hook could
//     infer a *likely* model from the middle two, but never the first or last.
//     An inferred model is not a measured one, and mispricing on a guessed
//     model is worse than pricing nothing; if you wire this, mark it inferred.
//
// This is also why no dollar figure comes off the legacy request denominator:
// GitHub is exact that one prompt is one premium request (tool calls inside it
// are free), so the COUNT is exact, but the multiplier needs the model and
// spans 0.25x to 57x. See the table's `_comment` for the sourcing.
//
// ── P14-016: reopened by the billing change, closed again with binary-level evidence ──
//
// The premise that reopened this (P14-015: tokens now price correctly) is real,
// but capturing them is still not reachable. Re-verified 2026-08-27:
//
//   - docs.github.com/en/copilot/reference/hooks-reference, fetched fresh: same
//     14 events, same fields, no usage/token/model anywhere. Unchanged from the
//     P14-007/P14-015 findings above.
//   - **Ground truth from the shipped binary**, not just the docs website: this
//     dev machine has GitHub Copilot CLI installed (`~/.copilot/pkg/`). Its
//     `agentStop` hook-payload builder, read directly out of the bundled
//     `index.js`, constructs exactly `{ timestamp, cwd, sessionId,
//     transcriptPath, stopReason }` — confirming the docs rather than
//     contradicting them.
//   - The bundle's own `schemas/session-events.schema.json` defines
//     `assistant.usage` — model, inputTokens, outputTokens, cacheReadTokens,
//     cacheWriteTokens, cost, PER TURN — but the schema marks it
//     `"ephemeral": true`, its own description reading "not persisted to the
//     session event log on disk". That is the internal/SDK event bus P14-007
//     described, confirmed from the artifact itself: real, per-turn, and
//     structurally unreachable from a spawned hook process.
//   - The same schema also defines `session.shutdown.data.modelMetrics`
//     (session-TOTAL, keyed by model, `requests.{count,cost}` +
//     `usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`) —
//     a formalized version of the `events.jsonl` P14-007 called undocumented.
//     It is schema-defined, but **empirically not written**: zero
//     `events.jsonl` files exist across ten real `~/.copilot/session-state/
//     <id>/` directories on this machine (Jan–Aug 2026, real usage). GitHub's
//     own github/copilot-cli#1394 (open, filed after the June 2026 billing
//     switch) says why directly — session totals are "only shown once to the
//     user but not persisted in events.jsonl or other files." That resolves
//     P14-007's "two sources disagree on reliability" in the negative, not the
//     positive: not reliably persisted **means not persisted**, on the one
//     real install available to check it against.
//   - github/copilot-cli#3551 (formalize events.jsonl as a public hook/
//     integration surface) is still open, opened 2026-05-28, no GitHub
//     response or commitment — unchanged from P14-007.
//
// Conclusion unchanged: no hook-reachable source of tokens or a model exists,
// documented or otherwise. Re-open only if #3551 or #1394 close, or a hook
// payload gains a usage field. Full writeup: `tasks/P14-016-copilot-token-
// capture-reopened.md`.

const COPILOT_EVENT_TYPE: Record<string, EventType> = {
  'agent-stop': 'Stop',
  notification: 'Notification',
  'post-tool-use': 'PostToolUse',
  // Same canonical type as a success; the failure shows up as exit_status.
  'post-tool-use-failure': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submitted': 'UserPromptSubmit',
};

const HOOK_KIND_TO_COPILOT_EVENT: Record<string, string> = {
  'agent-stop': 'agentStop',
  notification: 'notification',
  'post-tool-use': 'postToolUse',
  'post-tool-use-failure': 'postToolUseFailure',
  'pre-compact': 'preCompact',
  'pre-tool-use': 'preToolUse',
  'session-end': 'sessionEnd',
  'session-start': 'sessionStart',
  'subagent-stop': 'subagentStop',
  'user-prompt-submitted': 'userPromptSubmitted',
};

// Both spellings of every field, native first.
const COPILOT_FIELDS: Partial<FieldAliases> = {
  cwd: ['cwd'],
  sessionId: ['sessionId', 'session_id'],
  toolInput: ['toolArgs', 'tool_input'],
  toolName: ['toolName', 'tool_name'],
  toolResponse: ['toolResult', 'tool_response'],
};

/** Truthy, non-empty error content — not merely a present `error` key. */
function hasError(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).length > 0;
  }
  return value === true;
}

function buildCopilotToolInfo(
  raw: Record<string, unknown>,
  aliases: FieldAliases,
  kind: string,
): ToolInfo {
  const tool = buildGenericToolInfo(raw, aliases, kind, 'COPILOT');
  // postToolUseFailure carries the same tool fields plus an error; fold it into
  // PostToolUse with a non-zero exit rather than inventing an event type.
  //
  // The KIND is authoritative — a failure payload need not restate
  // `hook_event_name`, and sniffing the payload alone recorded such calls as
  // successes. The error-content check is a secondary signal, and it tests for
  // real content: payloads that always carry `error` (null/false/"" on success)
  // would otherwise mark every call failed.
  const nestedError =
    typeof raw.toolResult === 'object' && raw.toolResult !== null
      ? (raw.toolResult as Record<string, unknown>).error
      : undefined;
  if (kind === 'post-tool-use-failure' || hasError(raw.error) || hasError(nestedError)) {
    tool.exit_status = 1;
  }
  return tool;
}

// Copilot's own `timestamp` is a number in the camelCase form and an ISO-8601
// string in the PascalCase alias form. We stamp `ts` at capture time from the
// local clock either way; the agent's value rides along in metadata untouched, so
// neither encoding is lost or misparsed.

function renderSnippet(bin: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const [kind, copilotEvent] of Object.entries(HOOK_KIND_TO_COPILOT_EVENT)) {
    hooks[copilotEvent] = [
      {
        // Cross-platform `command` form (argv array) rather than `bash`, so the
        // same document works on Windows and a path with spaces is not split.
        command: [bin, 'hook', kind, '--agent', 'copilot'],
        timeoutSec: 5,
        type: 'command',
      },
    ];
  }
  return JSON.stringify({ disableAllHooks: false, hooks, version: 1 }, null, 2);
}

export const copilotAdapter: HookAdapter = createStdinHookAdapter({
  agentType: 'COPILOT',
  buildTool: buildCopilotToolInfo,
  eventMap: COPILOT_EVENT_TYPE,
  fields: COPILOT_FIELDS,
  install: {
    agentName: 'GitHub Copilot CLI',
    renderSnippet,
    settingsHint: 'Write this to ~/.copilot/hooks/aiot.json:',
  },
  nativeEvents: HOOK_KIND_TO_COPILOT_EVENT,
  // No `transcriptKinds`, so `transcriptTarget` stays the factory default (null)
  // for every kind — deliberately, not for lack of a path. UPDATE (P14-007):
  // `agentStop` / `preCompact` / `subagentStop` now document a `transcriptPath`
  // field (they did not at P12-006), but wiring transcript shipping off it is a
  // separate decision from usage capture — it needs its own look at what that
  // path actually names and at packages/redaction's obligations before this
  // adapter starts uploading it. See the P14-007 note above for why it would not
  // carry usage even if shipped.
});
