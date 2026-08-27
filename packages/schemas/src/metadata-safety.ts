// What `events.metadata` is allowed to carry (P14-008).
//
// THE INVARIANT. `DESIGN_DOC.md` §9.3 ("What is Never Stored Server-Side") says
// raw tool inputs/outputs and raw prompts never reach the events table — only
// hashes and sizes — and the schema comment on the sibling `scores.metadata`
// column states the same rule in one line: *provenance only; never raw content*.
// `packages/redaction` runs on the TRANSCRIPT path alone
// (`apps/ingest/src/lib/transcript-pipeline.ts`,
// `apps/hook/src/lib/transcript-stream.ts`); nothing redacts `events.metadata`,
// which `apps/ingest/src/lib/insert-events.ts` writes through to JSONB verbatim.
// So metadata's only safety property is what the producer chose to put in it.
//
// WHAT WENT WRONG. Every adapter's metadata builder was a DENYLIST: keys the
// adapter captured structurally were excluded, and *everything else passed
// through verbatim* so an unmodelled field would be preserved rather than lost.
// That is a sound instinct for `turn_id` or `model`. It is not sound for a field
// the vendor added later that happens to hold prose — and vendors keep adding
// them. Claude Code's Stop hook grew `last_assistant_message` ("Text content of
// the last assistant message before stopping"), and because no list named it, it
// landed in Postgres unredacted on every Stop and SubagentStop. Copilot CLI's
// `userPromptSubmitted` carries the user's whole `prompt`, which no Copilot-side
// list named either. Neither was a typo; both are the same structural defect —
// *unknown ⇒ verbatim*.
//
// THE RULE HERE replaces that with *unknown ⇒ bounded scalar*, in two parts:
//
//   1. A NAME rule — {@link CONTENT_BEARING_KEYS}, the payload keys vendors
//      document as carrying user-authored or model-generated text. Agent-neutral
//      on purpose: a key called `prompt` means the same thing whichever agent
//      sends it, and one shared list means a NEW adapter inherits the protection
//      instead of having to remember to opt in.
//   2. A SHAPE rule — {@link admitsToMetadata}. Objects and arrays are refused
//      outright (that is where unbounded vendor content lives: Claude's
//      `background_tasks[].description`, Gemini's `llm_response`, Codex's
//      `tool_calls[]`), and strings are capped at {@link MAX_METADATA_STRING}.
//      The shape rule is the part that does not need to know a field's name, so
//      it is the part that covers the field nobody has invented yet.
//
// HONEST RESIDUAL: a short, top-level, scalar string under a name nobody has
// listed still passes. The shape rule bounds how much of it can be stored; it
// cannot make the rule airtight. `apps/hook/test/metadata-content-free.test.ts`
// is what keeps the name list honest as vendors move.

/**
 * Payload keys that carry user-authored or model-generated CONTENT — prose,
 * prompts, file contents, command output, error bodies, summaries, titles.
 *
 * Both snake_case and camelCase spellings are listed because the agents disagree
 * (Copilot CLI is camelCase; Codex's `notify` payload is kebab-case, which is not
 * a valid identifier and so is listed as a quoted string like the rest).
 *
 * ADD TO THIS LIST rather than to a per-adapter exclusion list. A per-adapter
 * list only protects the agent whose author happened to read the vendor's
 * changelog that week — which is exactly how `last_assistant_message` got in.
 */
export const CONTENT_BEARING_KEYS: ReadonlySet<string> = new Set([
  // ── The turn's text, either direction ────────────────────────────────────
  // Claude Code: `Stop` / `SubagentStop` / `StopFailure`, described in its own
  // hook schema as "Text content of the last assistant message before stopping".
  // Codex's `notify` payload spells the same thing with hyphens.
  // Copilot CLI spells the same field `response` on `subagentStop` in its native
  // camelCase form and `last_assistant_message` in its PascalCase-event form, so
  // both spellings have to be listed or one form walks straight past.
  'assistant_message',
  'assistantMessage',
  'last-assistant-message',
  'last_assistant_message',
  'lastAssistantMessage',
  // Claude Code / Codex `UserPromptSubmit`, Gemini `BeforeAgent` ("the user's
  // original text submission"), Copilot `userPromptSubmitted`. Claude Code and
  // Codex already excluded `prompt` structurally; Gemini CLI and Copilot CLI did
  // not. Copilot also carries an optional opening prompt on `sessionStart`, and
  // Gemini's `AfterAgent` restates the prompt beside `prompt_response` ("final
  // agent-generated text").
  'initial_prompt',
  'initialPrompt',
  'prompt',
  'prompt_response',
  'promptResponse',
  'promptText',
  'transformed_prompt',
  'transformedPrompt',
  'user_prompt',
  'userPrompt',
  // Pi / OMP `before_agent_start`. `systemPrompt` is a string on Pi and an array
  // on OMP; `images` is attached image content, not a reference.
  'images',
  'system',
  'system_prompt',
  'systemPrompt',
  'systemPromptOptions',
  // Codex `notify` (`input-messages`) and the plural forms the plugin-shaped
  // agents use for a turn's message list.
  'input-messages',
  'input_messages',
  'inputMessages',
  'message',
  'messages',
  'content',
  'text',

  // ── Tool and error bodies ────────────────────────────────────────────────
  // Every adapter already captures tool_input/tool_response structurally (as
  // byte counts and a non-reversible target digest — DESIGN_DOC §5.3). These are
  // the spellings that appear OUTSIDE a tool event, where no such capture runs:
  // Claude Code `PostToolUseFailure`/`StopFailure`, Copilot CLI
  // `postToolUseFailure`. An error body routinely quotes the command output or
  // the file that failed to parse.
  // `toolResults` is Pi/OMP's `turn_end` list of this turn's tool outputs — it
  // arrives on a Stop, where no tool-block capture runs.
  'error',
  'error_details',
  'errorDetails',
  'output',
  'response',
  'result',
  'stderr',
  'stdout',
  'tool_results',
  'toolResults',

  // ── Summaries, titles and instructions ───────────────────────────────────
  // Claude Code `PreCompact.custom_instructions` (user-authored),
  // `PostCompact.compact_summary` ("The conversation summary produced by
  // compaction"), `SessionStart.session_title` (model-generated from the
  // conversation).
  'compact_summary',
  'compactSummary',
  'custom_instructions',
  'customInstructions',
  'description',
  'instructions',
  'session_title',
  'sessionTitle',
  'summary',
  'title',

  // ── Whole model exchanges ────────────────────────────────────────────────
  // Gemini CLI's `BeforeModel`/`AfterModel` payloads. Objects, so the shape rule
  // refuses them anyway — named here so the intent survives a future flattening.
  'llm_request',
  'llm_response',
  'diff',
  'patch',
]);

/**
 * Longest string an unmodelled key may contribute to metadata.
 *
 * Not a redaction threshold — a bound. Every structural value we have seen on a
 * real payload (a model id, a turn id, an ISO timestamp, an enum, a filesystem
 * path) fits comfortably; prose usually does not. It is the generic half of the
 * defense, and it is the half that works on a field name nobody has listed yet.
 */
export const MAX_METADATA_STRING = 200;

/**
 * May this payload key/value pair ride along in `events.metadata`?
 *
 * Applies to the PASSTHROUGH of raw agent payload keys only. Values a producer
 * DERIVES — `slash_command`, `notification_kind`, `tool_use_ids`, `source` — are
 * added after this filter and are not subject to it: they are computed, bounded
 * and content-free by construction, and `tool_use_ids` is an array that the
 * shape rule would otherwise refuse (which would silently break the P14-006
 * turn linkage).
 */
export function admitsToMetadata(key: string, value: unknown): boolean {
  if (CONTENT_BEARING_KEYS.has(key)) {
    return false;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_METADATA_STRING;
  }
  // Scalars only. `typeof null === 'object'`, so null is admitted explicitly —
  // it carries no content and dropping it would lose the "vendor sent this key
  // and it was empty" signal.
  return value === null || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * The name rule alone, for a consumer that must accept metadata it did not
 * build.
 *
 * `apps/ingest` uses this: the hook is a binary developers install and upgrade on
 * their own schedule, so a server that fixed capture today still receives the old
 * shape from every un-upgraded machine for as long as those machines run. Only
 * the NAME rule applies here — the shape rule would strip `tool_use_ids` and the
 * other derived values a legitimate producer writes.
 */
export function stripContentBearingKeys(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!CONTENT_BEARING_KEYS.has(key)) {
      clean[key] = value;
    }
  }
  return clean;
}
