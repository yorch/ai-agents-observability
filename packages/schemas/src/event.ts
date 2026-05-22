import { z } from 'zod';

import { SessionContextSchema } from './session-context';

export const AgentTypeSchema = z.enum(['claude-code']);
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
]);
export type EventType = z.infer<typeof EventTypeSchema>;

const ClientInfoSchema = z.object({
  claude_code_version: z.string(),
  hostname_hash: z.string(),
  os: z.enum(['darwin', 'linux', 'win32']),
});

const ToolInfoSchema = z.object({
  category: z.string(),
  duration_ms: z.number().int().nonnegative(),
  exit_status: z.number().int().nullable(),
  input_bytes: z.number().int().nonnegative(),
  input_hash: z.string().nullable(),
  mcp_server: z.string().nullable(),
  mcp_tool: z.string().nullable(),
  name: z.string(),
  output_bytes: z.number().int().nonnegative(),
  skill: z.string().nullable(),
  slash_command: z.string().nullable(),
  subagent_type: z.string().nullable(),
  was_denied: z.boolean(),
  was_interrupted: z.boolean(),
});

const LLMInfoSchema = z.object({
  cache_creation_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  model: z.string(),
  output_tokens: z.number().int().nonnegative(),
});

// v1: tool and llm are optional across all event types for simplicity. A future version should
// use z.discriminatedUnion('event_type', [...]) to enforce that PostToolUse/PreToolUse require
// tool, that LLM-producing events require llm, and that SessionStart carries neither.
export const EventSchema = z.object({
  agent_type: AgentTypeSchema.default('claude-code'),
  client: ClientInfoSchema,
  event_id: z.uuidv7(),
  event_type: EventTypeSchema,
  llm: LLMInfoSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  parent_event_id: z.uuidv7().nullable().optional(),
  redaction_flags: z.array(z.string()).default([]),
  schema_version: z.literal(1),
  session_context: SessionContextSchema,
  session_id: z.uuid(),
  tool: ToolInfoSchema.nullable().optional(),
  ts: z.iso.datetime({ offset: true }),
  turn_number: z.number().int().nonnegative().optional(),
  user_id_claim: z.string(),
});

export type Event = z.infer<typeof EventSchema>;

export const EventsBatchSchema = z.object({
  events: z.array(EventSchema),
  session_context: SessionContextSchema,
});

export type EventsBatch = z.infer<typeof EventsBatchSchema>;
