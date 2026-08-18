import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

/**
 * A model that produced billable tokens but resolved to no row in its agent's
 * price table, so every one of those events was costed at $0.
 */
export type UnpricedModel = {
  agentType: string;
  events: number;
  firstSeen: Date;
  inputTokens: number;
  lastSeen: Date;
  model: string;
  outputTokens: number;
};

const WINDOW_DAYS = 90;

/**
 * Which models are silently billing $0, and how much traffic that covers.
 *
 * `unknown_model_events_total` and the `unknown_model_surge` alert already count
 * this, but a count is not actionable: an operator who learns that 73 events
 * were unpriced still has to go grep ingest's logs to find out *which model* to
 * add. This answers that on the page where the tables are read.
 *
 * The heuristic is the same one the alert evaluator uses — a costed event with
 * tokens and no cost — because the price table is the only thing that can zero a
 * row with real token counts. It cannot distinguish "no price row" from "a row
 * whose rates are genuinely all zero", but no shipped table has one.
 */
export async function getUnpricedModels(): Promise<UnpricedModel[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const rows = await getPrisma().$queryRaw<
    {
      agent_type: string;
      events: bigint;
      first_seen: Date;
      input_tokens: bigint | null;
      last_seen: Date;
      model: string;
      output_tokens: bigint | null;
    }[]
  >(Prisma.sql`
    SELECT
      agent_type,
      model,
      COUNT(*)                              AS events,
      COALESCE(SUM(input_tokens), 0)        AS input_tokens,
      COALESCE(SUM(output_tokens), 0)       AS output_tokens,
      MIN(ts)                               AS first_seen,
      MAX(ts)                               AS last_seen
    FROM events
    WHERE ts >= ${since}
      AND model IS NOT NULL
      AND model <> ''
      AND COALESCE(cost_usd, 0) = 0
      AND (COALESCE(input_tokens, 0) > 0 OR COALESCE(output_tokens, 0) > 0)
    GROUP BY agent_type, model
    ORDER BY COUNT(*) DESC
    LIMIT 50
  `);

  return rows.map((r) => ({
    agentType: r.agent_type,
    events: Number(r.events),
    firstSeen: r.first_seen,
    inputTokens: Number(r.input_tokens ?? 0),
    lastSeen: r.last_seen,
    model: r.model,
    outputTokens: Number(r.output_tokens ?? 0),
  }));
}

export const UNPRICED_WINDOW_DAYS = WINDOW_DAYS;
