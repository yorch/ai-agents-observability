import { uuidv5 } from './uuid5';

// Session-ID normalization for the adapter seam (P12-002).
//
// `EventSchema` requires `session_id` to be a UUID, and ingest validates each event
// individually and DROPS the ones that fail (routes/events.ts) — tolerant by design,
// which means a malformed id is silently lost rather than loudly rejected. Most
// agents do not hand out UUIDs:
//
//   claude-code  8f4e…-…                    UUID          → pass through
//   pi           <timestamp>_<uuid>.jsonl   UUID          → pass through
//   opencode     ses_7bQ…                   NOT a UUID    → derive
//   omp          1f9d2a6b9c0d1234           NOT a UUID    → derive
//   codex/copilot/gemini                    unspecified   → derive when not a UUID
//
// Derivation is UUIDv5 over `<agent_type>:<native id>`, so it is stable across
// processes (the same session's events all agree) and namespaced by agent (two
// agents that both hand out `ses_abc` do not collide).

/**
 * Fixed namespace for derived session IDs. NEVER change this value — every event
 * of an in-flight session would re-derive to a different id and split the session
 * in two.
 */
export const SESSION_NAMESPACE = '3c5f8a12-7d4e-5b96-a081-6e2c94f7b3d5';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A valid UUID for `agentType`'s session `nativeId`.
 *
 * Already-UUID ids pass through unchanged (lowercased) so agents that hand out real
 * UUIDs keep their own identifier — the one users see in the agent's own UI. Anything
 * else is derived deterministically. Missing/empty ids collapse to the nil UUID, the
 * pre-existing "unknown session" sentinel.
 */
export function sessionUuid(agentType: string, nativeId: unknown): string {
  if (typeof nativeId !== 'string' || nativeId.length === 0) {
    return NIL_UUID;
  }
  if (UUID_RE.test(nativeId)) {
    return nativeId.toLowerCase();
  }
  return uuidv5(`${agentType}:${nativeId}`, SESSION_NAMESPACE);
}
