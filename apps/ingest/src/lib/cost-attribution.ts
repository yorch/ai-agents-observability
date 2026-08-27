import type { ModelPrice } from '@ai-agents-observability/schemas';

/**
 * Turn-linked cost attribution (P14-004) — the arithmetic, with no database in
 * sight so it can be tested directly.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Real spend accrues per **assistant turn**, not per tool call. The `Stop` event
 * that closes turn N carries the model and the four token counts, so ingest
 * prices it into `events.cost_usd`; the tool events that turn issued carry no
 * tokens and are priced at nothing. Any "what did this tool / skill / sub-agent
 * cost?" answer is therefore a *redistribution* of a turn's cost onto the calls
 * that turn made, and the redistribution has to be written down somewhere a
 * reader can check it. Here.
 *
 * ── The two attributions ────────────────────────────────────────────────────
 *
 * **Issuing-turn share** (`attributedCostUsd`). For each `PostToolUse` event in
 * turn N: `Stop(N).cost_usd / (number of PostToolUse events in turn N)`. An even
 * split, because nothing in the payload says which of a turn's tool calls the
 * model spent its tokens deciding on. A turn that issued no tools keeps its cost
 * unattributed, so **the sum of this column over a session is ≤ the session
 * total** — the difference is the model's own thinking, which belongs to no tool.
 *
 * **Downstream inflation** (`downstreamCostUsd`). A tool's output is pasted back
 * into the conversation and re-read by the *next* turn, so a chatty tool costs
 * money it never appears next to. For a tool event `t` in turn N with
 * `tool_output_bytes = b_t`, turn N+1's **input-side** cost is apportioned as
 * `b_t / Σ b`. Input-side means input + cache-read + cache-creation and
 * deliberately **not** output tokens: those are the model's own generation, not
 * something a tool's output caused.
 *
 * **This is an approximation.** Bytes are a proxy for tokens, and the ratio
 * varies by content — JSON and source code tokenize very differently from prose.
 * It is right about which tools are expensive and roughly right about by how
 * much; it is not an invoice line. Say so wherever it is displayed.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 * The two numbers are **two lenses on the same dollars, not two costs**. Turn
 * N's cost appears once as its own tools' issuing share, and turn N+1's
 * input-side cost appears again as the previous turn's tools' downstream
 * inflation. Summing them double-counts. Never add them together, never total
 * them into a single "cost" column, and never let either feed
 * `sessions.total_cost_usd`, `pr_rollups.total_cost_usd`, or the continuous
 * aggregates — that chain already counts these dollars exactly once, at the Stop
 * event (see `jobs/reprice-events.ts` for the four-way chain).
 */

/** The `Stop` event closes an assistant turn and carries that turn's usage. */
export const TURN_END_EVENT_TYPE = 'Stop';

/**
 * Attribution lands on `PostToolUse` rows only, and the divisor counts only
 * those.
 *
 * A completed tool call emits both `PreToolUse` and `PostToolUse`; splitting
 * across both would halve every number the dashboards read, because every
 * per-tool aggregate in `apps/web` filters `event_type = 'PostToolUse'`. One row
 * per completed call, and it is the row the product already counts.
 */
export const TOOL_EVENT_TYPE = 'PostToolUse';

/** Stored cost is `NUMERIC(12, 6)`; round to match rather than let PG do it. */
const COST_SCALE = 6;

export type AttributionEvent = {
  agentType: string;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  eventId: string;
  eventType: string;
  inputTokens: number | null;
  model: string | null;
  toolOutputBytes: number | null;
  ts: Date;
  /** NULL when the adapter did not report turn linkage. No linkage, no attribution. */
  turnNumber: number | null;
};

export type AttributionRow = {
  /** NULL = not attributed. Never a stand-in for "$0.00 of cost". */
  attributedCostUsd: number | null;
  downstreamCostUsd: number | null;
  eventId: string;
  ts: Date;
};

/** Resolves an agent's price table and looks the model up in it. */
export type PriceLookup = (agentType: string, model: string) => ModelPrice | undefined;

function round(usd: number): number {
  return Number(usd.toFixed(COST_SCALE));
}

/**
 * The input-side cost of one turn: what the model was charged to *read* its
 * context. Output tokens are excluded on purpose — see the header.
 *
 * Returns null for an unpriced model, which is the P8-002 rule holding here too:
 * an unknown model attributes nothing rather than being guessed at.
 */
export function inputSideCostUsd(stop: AttributionEvent, priceFor: PriceLookup): number | null {
  if (!stop.model) {
    return null;
  }
  const price = priceFor(stop.agentType, stop.model);
  if (!price) {
    return null;
  }
  return (
    ((stop.inputTokens ?? 0) * price.input_per_mtok +
      (stop.cacheReadTokens ?? 0) * price.cache_read_per_mtok +
      (stop.cacheCreationTokens ?? 0) * price.cache_write_per_mtok) /
    1_000_000
  );
}

type Turn = { stop: AttributionEvent | undefined; tools: AttributionEvent[] };

/** Groups one session's events by turn. Events with no `turnNumber` are dropped. */
function groupByTurn(events: AttributionEvent[]): Map<number, Turn> {
  const turns = new Map<number, Turn>();
  for (const e of events) {
    if (e.turnNumber === null) {
      // No turn linkage means no attribution — produce nothing rather than
      // attribute a turn's cost to a tool call that may belong to another turn.
      continue;
    }
    let turn = turns.get(e.turnNumber);
    if (!turn) {
      turn = { stop: undefined, tools: [] };
      turns.set(e.turnNumber, turn);
    }
    if (e.eventType === TURN_END_EVENT_TYPE) {
      // A turn has one Stop. If a re-ingest produced two, the priced one wins:
      // taking the second unconditionally would drop the cost to null.
      if (!turn.stop || (turn.stop.costUsd === null && e.costUsd !== null)) {
        turn.stop = e;
      }
    } else if (e.eventType === TOOL_EVENT_TYPE) {
      turn.tools.push(e);
    }
  }
  return turns;
}

/**
 * Both attributions for one session's events.
 *
 * Deterministic: the output depends only on the input rows, never on when it
 * ran or on what is already stored. That is what makes the job idempotent — a
 * second run recomputes the same numbers and writes nothing.
 *
 * Emits a row only for tool events that got at least one of the two numbers, so
 * a session with no turn linkage produces an empty array rather than a page of
 * confident zeroes.
 */
export function computeSessionAttribution(
  events: AttributionEvent[],
  priceFor: PriceLookup,
): AttributionRow[] {
  const turns = groupByTurn(events);
  const rows: AttributionRow[] = [];

  for (const [turnNumber, turn] of turns) {
    if (turn.tools.length === 0) {
      // A turn that issued no tools keeps its cost unattributed. This is the
      // reason the column sums to ≤ the session total.
      continue;
    }

    // ── Issuing-turn share ───────────────────────────────────────────────────
    const stopCost = turn.stop?.costUsd ?? null;
    const share = stopCost === null ? null : round(stopCost / turn.tools.length);

    // ── Downstream inflation ─────────────────────────────────────────────────
    // Proportions are taken over this turn's tool outputs, so they sum to 1
    // across the tools that fed turn N+1 (up to the 6-decimal rounding below).
    const nextStop = turns.get(turnNumber + 1)?.stop;
    const nextInputCost = nextStop ? inputSideCostUsd(nextStop, priceFor) : null;
    const totalBytes = turn.tools.reduce((sum, t) => sum + Math.max(0, t.toolOutputBytes ?? 0), 0);
    const canAttributeDownstream = nextInputCost !== null && totalBytes > 0;

    for (const tool of turn.tools) {
      const bytes = Math.max(0, tool.toolOutputBytes ?? 0);
      const downstream = canAttributeDownstream
        ? round((nextInputCost as number) * (bytes / totalBytes))
        : null;
      if (share === null && downstream === null) {
        continue;
      }
      rows.push({
        attributedCostUsd: share,
        downstreamCostUsd: downstream,
        eventId: tool.eventId,
        ts: tool.ts,
      });
    }
  }

  return rows;
}
