/**
 * Resolving live tool events to the assistant turn that issued them (P14-006).
 *
 * The arithmetic-free half of `jobs/link-turn-events.ts`, split out for the same
 * reason `packages/schemas/src/cost-attribution.ts` is: the definition of
 * "which turn issued this call" is the thing worth testing, and it should be
 * testable without a database. The job is the plumbing.
 *
 * This is a **lookup, not an estimate**. It consults no clock and assumes no
 * ordering. An id it cannot place is left alone.
 */

/**
 * The metadata key a Stop event carries its turn's issued tool-call ids under.
 *
 * The producing half is `TOOL_USE_IDS_METADATA_KEY` in
 * `apps/hook/src/lib/claude-turns.ts`. Ingest cannot import it — the hook is a
 * compiled CLI, not a library this app depends on — so the string is restated
 * here, once, with a pointer back. `test/turn-linkage.test.ts` reads the hook's
 * source and asserts the two agree, so the duplication cannot drift silently.
 */
export const TOOL_USE_IDS_METADATA_KEY = 'tool_use_ids';

/** A `Stop` row: which turn it is, and which tool calls that turn issued. */
export type StopTurn = {
  /** The Stop's own `event_id` — what a linked tool row's `parent_event_id` becomes. */
  eventId: string;
  /** The row's `metadata` jsonb, as the driver returned it. */
  metadata: unknown;
  /** 1-based assistant-turn ordinal. */
  turnNumber: number;
};

/** A tool row awaiting linkage. */
export type ToolEvent = {
  eventId: string;
  toolUseId: string;
  ts: Date;
};

/** One resolved linkage. Mirrors `LinkageRow` in the job. */
export type ResolvedLink = {
  eventId: string;
  parentEventId: string;
  ts: Date;
  turnNumber: number;
};

/**
 * The tool-call ids a Stop row claims its turn issued.
 *
 * Defensive about the jsonb it is handed rather than trusting the writer: this
 * value crossed a process boundary from a binary on a developer's machine, and
 * a hook older than P14-006 (or any other agent) simply has no such key. A shape
 * that is not an array of non-empty strings yields nothing, which degrades to
 * "this turn linked no calls" — never to a wrong link.
 */
export function issuedToolUseIds(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return [];
  }
  const raw = (metadata as Record<string, unknown>)[TOOL_USE_IDS_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Resolve one session's unlinked tool events against its Stop rows.
 *
 * `unresolved` counts the tool rows whose id no Stop in this session claimed.
 * That is a real and expected state — a transcript truncated before the turn was
 * written, a session captured by a hook that predates P14-006, a Stop that never
 * shipped — and the honest answer for those rows is to leave `turn_number` NULL
 * so `compute-cost-attribution` reads them as "not attributed" rather than
 * `$0.00`. The count is logged so the gap is visible instead of silent.
 *
 * ── The duplicate-id rule ───────────────────────────────────────────────────
 *
 * A tool-call id is unique within a session by construction — it is the id of
 * one `tool_use` block in one assistant message. If two Stops nonetheless claim
 * the same id (a transcript re-read that emitted a turn twice, a `--resume`d
 * file whose numbering restarted), the FIRST claim wins and the second is
 * ignored. Deterministic beats last-write-wins here: the two runs of this job
 * must not disagree about which turn a dollar belongs to.
 */
export function linkageForSession(
  stops: StopTurn[],
  tools: ToolEvent[],
): { rows: ResolvedLink[]; unresolved: number } {
  const originByToolUseId = new Map<string, StopTurn>();
  for (const stop of stops) {
    for (const id of issuedToolUseIds(stop.metadata)) {
      if (!originByToolUseId.has(id)) {
        originByToolUseId.set(id, stop);
      }
    }
  }

  const rows: ResolvedLink[] = [];
  let unresolved = 0;
  for (const tool of tools) {
    const origin = originByToolUseId.get(tool.toolUseId);
    if (!origin) {
      unresolved += 1;
      continue;
    }
    rows.push({
      eventId: tool.eventId,
      parentEventId: origin.eventId,
      ts: tool.ts,
      turnNumber: origin.turnNumber,
    });
  }
  return { rows, unresolved };
}
