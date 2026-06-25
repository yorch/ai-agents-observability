import { Prisma } from '@ai-agents-observability/db';
import type { Event } from '@ai-agents-observability/schemas';

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
        tool_input_bytes, tool_output_bytes, tool_duration_ms,
        tool_exit_status, tool_was_denied, tool_was_interrupted,
        mcp_server, mcp_tool, subagent_type,
        skill_name, skill_path, slash_command,
        model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd,
        mode, metadata
      ) VALUES ${Prisma.join(rows)}
      ON CONFLICT (event_id) DO NOTHING
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
