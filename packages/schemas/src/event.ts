import { z } from 'zod';

import { SessionContextSchema } from './session-context';

export const AgentTypeSchema = z.enum([
  'claude-code',
  'cursor',
  'aider',
  'copilot',
  'codex',
  'windsurf',
  'opencode',
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const EventTypeSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
  'PreCompact',
  'SubagentStop',
  'Notification',
  // Distinct from Stop — fires when the session itself ends (vs. a single
  // response stopping). Listed as valid in DESIGN_DOC §5.3; without it a hook
  // emitting SessionEnd would fail validation.
  'SessionEnd',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

const ClientInfoSchema = z.object({
  claude_code_version: z.string(),
  hostname_hash: z.string(),
  os: z.enum(['darwin', 'linux', 'win32']),
});

// Tool fields that aren't knowable at capture time (duration, exit, output size)
// default rather than being required, so the hook can emit a tool block from
// just `tool_name` + `tool_input`. `name` is the only hard requirement.
const ToolInfoSchema = z.object({
  category: z.string().default('other'),
  duration_ms: z.number().int().nonnegative().default(0),
  exit_status: z.number().int().nullable().default(null),
  input_bytes: z.number().int().nonnegative().default(0),
  input_hash: z.string().nullable().default(null),
  mcp_server: z.string().nullable().default(null),
  mcp_tool: z.string().nullable().default(null),
  name: z.string(),
  output_bytes: z.number().int().nonnegative().default(0),
  skill: z.string().nullable().default(null),
  slash_command: z.string().nullable().default(null),
  subagent_type: z.string().nullable().default(null),
  was_denied: z.boolean().default(false),
  was_interrupted: z.boolean().default(false),
});

export type ToolInfo = z.infer<typeof ToolInfoSchema>;

const LLMInfoSchema = z.object({
  cache_creation_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  model: z.string(),
  output_tokens: z.number().int().nonnegative(),
});

// Fields shared by every event variant. `event_type`, `tool`, and `llm` are added
// per-variant by the discriminated union below.
const baseEventShape = {
  agent_type: AgentTypeSchema.default('claude-code'),
  client: ClientInfoSchema,
  event_id: z.uuidv7(),
  llm: LLMInfoSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  parent_event_id: z.uuidv7().nullable().optional(),
  // Informational only: which client-side redaction classes fired for this
  // event's content. There is no `redaction_flags` column on the events
  // hypertable (§9.1 keeps flags with the transcript / session, not per-event);
  // ingest accepts but does not persist this field.
  redaction_flags: z.array(z.string()).default([]),
  schema_version: z.literal(1),
  session_context: SessionContextSchema,
  session_id: z.uuid(),
  ts: z.iso.datetime({ offset: true }),
  turn_number: z.number().int().nonnegative().optional(),
  user_id_claim: z.string(),
};

// `tool` is REQUIRED on the two tool-lifecycle events (so analytics that count
// tool calls / read tool_name can rely on it — see upsert-session.ts and
// insert-events.ts) and optional elsewhere. Keeping the key present (optional)
// on every variant lets consumers use `e.tool?.…` uniformly across the union.
const toolOptional = ToolInfoSchema.nullable().optional();

export const EventSchema = z.discriminatedUnion('event_type', [
  z.object({ ...baseEventShape, event_type: z.literal('PreToolUse'), tool: ToolInfoSchema }),
  z.object({ ...baseEventShape, event_type: z.literal('PostToolUse'), tool: ToolInfoSchema }),
  z.object({ ...baseEventShape, event_type: z.literal('SubagentStop'), tool: toolOptional }),
  z.object({ ...baseEventShape, event_type: z.literal('SessionStart'), tool: toolOptional }),
  z.object({ ...baseEventShape, event_type: z.literal('Stop'), tool: toolOptional }),
  z.object({ ...baseEventShape, event_type: z.literal('SessionEnd'), tool: toolOptional }),
  z.object({ ...baseEventShape, event_type: z.literal('UserPromptSubmit'), tool: toolOptional }),
  z.object({ ...baseEventShape, event_type: z.literal('PreCompact'), tool: toolOptional }),
  z.object({ ...baseEventShape, event_type: z.literal('Notification'), tool: toolOptional }),
]);

export type Event = z.infer<typeof EventSchema>;

export const EventsBatchSchema = z.object({
  events: z.array(EventSchema),
  session_context: SessionContextSchema,
});

export type EventsBatch = z.infer<typeof EventsBatchSchema>;

// Lenient envelope for tolerant ingestion: the `events` array is left unparsed
// so the caller can validate each event individually (EventSchema.safeParse) and
// accept the valid ones rather than rejecting the whole batch — which, because
// the flusher treats a 4xx as "bad data" and drops the rows, would otherwise
// turn one malformed event into the loss of every co-batched event.
export const EventsBatchEnvelopeSchema = z.object({
  events: z.array(z.unknown()),
  session_context: SessionContextSchema,
});

export type EventsBatchEnvelope = z.infer<typeof EventsBatchEnvelopeSchema>;
