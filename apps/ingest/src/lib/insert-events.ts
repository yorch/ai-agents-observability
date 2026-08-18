import { Prisma } from '@ai-agents-observability/db';
import {
  type Event,
  mergeRunKind,
  type RunKindDb,
  runKindToDbEnum,
} from '@ai-agents-observability/schemas';

import { computeCostUsd } from './cost';
import type { PriceTableRegistry } from './price-tables';

type RawDb = {
  $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
};

export type InsertResult = {
  accepted: number;
  acceptedEventIds: Set<string>;
  deduped: number;
  /** Models seen in this batch that were absent from the price table. */
  unknownModels: Set<string>;
};

export async function insertEventsBatch(
  db: RawDb,
  events: Event[],
  userId: string,
  priceTables: PriceTableRegistry,
): Promise<InsertResult> {
  const unknownModels = new Set<string>();
  if (events.length === 0) {
    return { accepted: 0, acceptedEventIds: new Set(), deduped: 0, unknownModels };
  }

  // One run_kind per session for the whole batch, by the same merge rule
  // upsertSessions applies to the session row (packages/schemas mergeRunKind).
  // Written per event rather than taken per event so that a batch whose
  // SessionStart omitted the field cannot leave half its events INTERACTIVE and
  // half CI — events.run_kind is read without a sessions join on most paths, so a
  // within-batch split would be invisible and permanent.
  const runKindBySession = new Map<string, RunKindDb>();
  for (const e of events) {
    const claimed = runKindToDbEnum(e.session_context.run_kind);
    const seen = runKindBySession.get(e.session_id);
    runKindBySession.set(e.session_id, seen ? mergeRunKind(seen, claimed) : claimed);
  }

  const rows = events.map((e) => {
    const costUsd = e.llm
      ? computeCostUsd(
          e.llm.model,
          e.llm.input_tokens,
          e.llm.output_tokens,
          e.llm.cache_read_tokens,
          e.llm.cache_creation_tokens,
          priceTables.resolve(e.agent_type),
          unknownModels,
          e.agent_type,
        )
      : null;

    // Tool names stored raw; disambiguate by (agent_type, tool_name) at query time when needed.
    return Prisma.sql`(
      ${e.event_id}::uuid,
      ${e.session_id}::uuid,
      ${userId}::uuid,
      ${new Date(e.ts)},
      ${e.agent_type},
      ${e.event_type},
      ${e.turn_number ?? null},
      ${e.parent_event_id ?? null}::uuid,
      ${e.tool?.name ?? null},
      ${e.tool?.category ?? null},
      ${e.tool?.input_hash ?? null},
      ${e.tool?.target_hash ?? null},
      ${e.tool?.action ?? null},
      ${e.tool?.input_bytes ?? null},
      ${e.tool?.output_bytes ?? null},
      ${e.tool?.duration_ms ?? null},
      ${e.tool?.exit_status ?? null},
      ${e.tool?.was_denied ?? null},
      ${e.tool?.was_interrupted ?? null},
      ${e.tool?.mcp_server ?? null},
      ${e.tool?.mcp_tool ?? null},
      ${e.tool?.subagent_type ?? null},
      ${e.tool?.skill ?? null},
      ${null},
      ${e.tool?.slash_command ?? (typeof e.metadata.slash_command === 'string' ? e.metadata.slash_command : null)},
      ${e.llm?.model ?? null},
      ${e.llm?.input_tokens ?? null},
      ${e.llm?.output_tokens ?? null},
      ${e.llm?.cache_read_tokens ?? null},
      ${e.llm?.cache_creation_tokens ?? null},
      ${costUsd},
      ${e.session_context.mode},
      ${runKindBySession.get(e.session_id) ?? runKindToDbEnum(e.session_context.run_kind)},
      ${typeof e.metadata.notification_kind === 'string' ? e.metadata.notification_kind : null},
      ${JSON.stringify(e.metadata)}::jsonb
    )`;
  });

  // RETURNING tells us exactly which event_ids were newly inserted vs dropped
  // by ON CONFLICT. The caller needs this to avoid double-counting session
  // aggregates when a retry replays an already-accepted batch.
  const returned = await db.$queryRaw<{ event_id: string }[]>(
    Prisma.sql`
      INSERT INTO events (
        event_id, session_id, user_id, ts,
        agent_type, event_type, turn_number, parent_event_id,
        tool_name, tool_category, tool_input_hash,
        tool_target_hash, tool_action,
        tool_input_bytes, tool_output_bytes, tool_duration_ms,
        tool_exit_status, tool_was_denied, tool_was_interrupted,
        mcp_server, mcp_tool, subagent_type,
        skill_name, skill_path, slash_command,
        model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd,
        mode, run_kind, notification_kind, metadata
      ) VALUES ${Prisma.join(rows)}
      ON CONFLICT (event_id, ts) DO NOTHING
      RETURNING event_id
    `,
  );

  const acceptedEventIds = new Set(returned.map((r) => r.event_id));

  return {
    accepted: acceptedEventIds.size,
    acceptedEventIds,
    deduped: events.length - acceptedEventIds.size,
    unknownModels,
  };
}
